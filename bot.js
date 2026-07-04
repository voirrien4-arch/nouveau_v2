// Delta Gold - Baileys WhatsApp Connection
// Handles socket lifecycle, reconnection, message routing, and web command execution
// Shared state: botMode (public/private) accessible via getBotMode/setBotMode

import * as Baileys from '@whiskeysockets/baileys';
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = Baileys;
import pino from 'pino';
import fs from 'fs';
import { handleCommand } from './commands.js';
import { askAI } from './ai.js';
 
const logger = pino({ level: 'silent' });
let sock = null;
const startTime = Date.now();

// ── Pairing lifecycle state ──
// Pending pairing request: { phone, resolve, reject }
let pendingPairing = null;
let isStarting = false;

// Recording store: Map<groupJid, Array<{sender, pushName, text, time}>>
const recordingStore = new Map();

// ── Translation store: Map<ownerNumber, { lang, langName }> ──
const translationStore = new Map();

const LANG_MAP = {
  fr: { name: 'Français', prompt: 'français' },
  an: { name: 'Anglais', prompt: 'anglais' },
  pt: { name: 'Portugais', prompt: 'portugais' },
  al: { name: 'Allemand', prompt: 'allemand' },
  ht: { name: 'Haïtien', prompt: 'créole haïtien' },
  br: { name: 'Brésilien', prompt: 'portugais brésilien' },
};

export function setTranslationMode(ownerKey, lang) {
  const entry = LANG_MAP[lang];
  if (!entry) return false;
  translationStore.set(ownerKey, { lang, langName: entry.name });
  return true;
}

export function clearTranslationMode(ownerKey) {
  translationStore.delete(ownerKey);
}

export function getTranslationMode(ownerKey) {
  return translationStore.get(ownerKey) || null;
}

// ── Bot mode: 'public' (anyone) or 'private' (owner-only) ──
let botMode = 'private';

const botStatus = {
  connected: false,
  phone: null,
  registered: false,
  initializing: true,
  lastError: null,
  restarts: 0,
};

export function getBotMode() {
  return botMode;
}

export function setBotMode(mode) {
  if (mode === 'public' || mode === 'private') botMode = mode;
}

export async function startBot() {
  // ── Idempotent guard: prevent double-start ──
  if (isStarting) {
    console.log('⏳ startBot() déjà en cours, ignoré');
    return;
  }
  isStarting = true;

  try {
    botStatus.initializing = true;
    botStatus.lastError = null;

    // ── Close previous socket cleanly ──
    if (sock) {
      try {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('creds.update');
        sock.ev.removeAllListeners('messages.upsert');
        sock.ev.removeAllListeners('group-participants.update');
        sock.end(undefined);
      } catch {}
      sock = null;
      // Brief delay for cleanup
      await new Promise(r => setTimeout(r, 500));
    }

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      browser: ['Delta Gold', 'Safari', '3.0'],
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
    });

    botStatus.registered = sock.authState.creds.registered;
    botStatus.initializing = false;

    console.log(`🔑 Bot registered: ${botStatus.registered}`);
    console.log(`🔑 Auth creds exist: ${!!state.creds?.noiseKey}`);

    // Save credentials on update
    sock.ev.on('creds.update', saveCreds);

    // Connection lifecycle
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log('📱 QR code généré — pairing code sera demandé quand le socket sera prêt');
        // Socket is ready for pairing code now
        await handlePendingPairing();
      }

      if (connection === 'close') {
        botStatus.connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || 'Connexion fermée';

        console.log(`🔌 Connexion fermée: ${errMsg} (code: ${statusCode})`);

        // Reject any pending pairing on disconnect
        if (pendingPairing) {
          pendingPairing.reject(new Error('Socket déconnecté pendant le pairing. Réessayez.'));
          pendingPairing = null;
        }

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('❌ Session expirée. Suppression des credentials...');
          try { fs.rmSync('./auth_info', { recursive: true, force: true }); } catch {}
          botStatus.registered = false;
          botStatus.lastError = 'Session expirée. Veuillez vous reconnecter.';
        } else {
          botStatus.lastError = `Déconnecté: ${errMsg}`;
        }

        botStatus.restarts++;
        const delay = statusCode === DisconnectReason.loggedOut ? 2000 : 5000;
        console.log(`🔄 Reconnexion dans ${delay / 1000}s... (tentative #${botStatus.restarts})`);
        setTimeout(() => { isStarting = false; startBot(); }, delay);

      } else if (connection === 'open') {
        botStatus.connected = true;
        botStatus.registered = true;
        botStatus.lastError = null;
        botStatus.phone = sock.user?.id?.split(':')[0] || null;
        console.log(`✅ Delta Gold connecté: +${botStatus.phone}`);

        // If somehow pairing was pending and socket connected, resolve
        if (pendingPairing) {
          pendingPairing.reject(new Error('Le bot s\'est connecté automatiquement ! Aucun code nécessaire.'));
          pendingPairing = null;
        }
      }
    });

    // Message handler with recording + translation support
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const ownerNum = process.env.OWNER_NUMBER || '224612908366';
      const prefix = process.env.BOT_PREFIX || '.';

      for (const msg of messages) {
        if (!msg.message) continue;

        const msgFrom = msg.key.remoteJid;

        // ── Owner's own messages (fromMe): handle translation edit ──
        if (msg.key.fromMe) {
          const rawText = msg.message?.conversation
            || msg.message?.extendedTextMessage?.text
            || msg.message?.imageMessage?.caption
            || msg.message?.videoMessage?.caption
            || '';

          // If it's a normal message (not a command) and translation is active → edit with translation
          if (rawText && !rawText.startsWith(prefix) && translationStore.has(ownerNum)) {
            const { langName } = translationStore.get(ownerNum);
            try {
              const translated = await askAI(
                'Traduis ce texte en ' + langName + '. Réponds UNIQUEMENT avec la traduction, rien d\'autre.\n\nTexte: ' + rawText,
                'Tu es un traducteur professionnel. Tu réponds uniquement avec la traduction demandée, sans explication ni commentaire ni guillemets.'
              );
              if (translated && !translated.startsWith('⚠️')) {
                // Edit the original message in-place with the translation
                await sock.sendMessage(msgFrom, {
                  edit: msg.key,
                  text: translated,
                });
                console.log('🌐 Message édité (' + langName + '): "' + rawText.substring(0, 30) + '..." → "' + translated.substring(0, 30) + '..."');
              }
            } catch (err) {
              console.error('Translation edit error:', err.message);
            }
          }
          continue; // Always skip fromMe messages (don't process as commands)
        }

        // ── Messages from others ──

        // Record message if recording is active for this group
        if (msgFrom?.endsWith('@g.us') && recordingStore.has(msgFrom)) {
          const text = msg.message?.conversation
            || msg.message?.extendedTextMessage?.text
            || msg.message?.imageMessage?.caption
            || msg.message?.videoMessage?.caption
            || '[média]';
          recordingStore.get(msgFrom).push({
            sender: (msg.key.participant || msg.key.remoteJid).split('@')[0].replace(/:\d+$/, ''),
            pushName: msg.pushName || 'Inconnu',
            text,
            time: new Date().toISOString(),
          });
        }

        // Handle commands
        try {
          await handleCommand(sock, msg, {
            requestPairingCode, recordingStore, botMode, setBotMode,
            setTranslationMode, clearTranslationMode, getTranslationMode, translationStore,
          });
        } catch (err) {
          console.error('Handler error:', err.message);
        }
      }
    });

    // ── Group participants update: farewell message when owner is removed ──
    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
      const ownerNum = process.env.OWNER_NUMBER || '224612908366';
      const ownerJid = ownerNum + '@s.whatsapp.net';

      if (action === 'remove' && participants.includes(ownerJid)) {
        try {
          await sock.sendMessage(id, {
            text: 'Ce groupe était naze🫵😂',
          });
          console.log('👋 Owner retiré du groupe ' + id + ' — message d\'adieu envoyé');
        } catch (err) {
          console.error('Farewell message error:', err.message);
        }
      }
    });

    isStarting = false;

    // If there's a pending pairing request, handle it now
    if (pendingPairing && !botStatus.connected) {
      await handlePendingPairing();
    }

  } catch (err) {
    console.error('Bot start error:', err.message);
    botStatus.initializing = false;
    botStatus.lastError = 'Erreur de démarrage: ' + err.message;
    botStatus.restarts++;
    isStarting = false;
    if (pendingPairing) {
      pendingPairing.reject(new Error('Erreur de démarrage: ' + err.message));
      pendingPairing = null;
    }
    setTimeout(() => startBot(), 5000);
  }
}

// ── Handle pending pairing code request ──
async function handlePendingPairing() {
  if (!pendingPairing || !sock) return;

  const { phone, resolve, reject } = pendingPairing;

  try {
    // If already connected, no pairing needed
    if (botStatus.connected) {
      reject(new Error('Le bot est déjà connecté ! Aucun code nécessaire.'));
      pendingPairing = null;
      return;
    }

    console.log(`📱 Génération du code de pairing pour: +${phone}`);
    const code = await sock.requestPairingCode(phone);
    console.log(`✅ Code de pairing généré: ${code}`);
    resolve(code);
    pendingPairing = null;
  } catch (err) {
    console.error('❌ Erreur pairing:', err.message);
    reject(new Error(`Impossible de générer le code: ${err.message}`));
    pendingPairing = null;
  }
}

// ── Request Pairing Code ──
export async function requestPairingCode(phone) {
  return new Promise(async (resolve, reject) => {
    // If bot is still initializing with no socket yet, wait briefly
    if (botStatus.initializing && !sock) {
      reject(new Error('Le bot est en cours de démarrage. Patientez 10 secondes et réessayez.'));
      return;
    }

    if (!sock) {
      reject(new Error('Le bot n\'a pas pu démarrer. Vérifiez les logs Render sur render.com.'));
      return;
    }

    // If already connected, no pairing needed
    if (botStatus.connected) {
      reject(new Error('Le bot est déjà connecté ! Aucun code de pairing nécessaire.'));
      return;
    }

    // If registered but not connected, auto-reset session for fresh pairing
    if (botStatus.registered && !pendingPairing) {
      console.log('🔄 Session existante détectée — suppression pour nouveau pairing...');
      try {
        // Clean up old socket
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('creds.update');
        sock.ev.removeAllListeners('messages.upsert');
        sock.ev.removeAllListeners('group-participants.update');
        sock.end(undefined);
      } catch {}
      sock = null;

      // Delete old auth
      if (fs.existsSync('./auth_info')) {
        fs.rmSync('./auth_info', { recursive: true, force: true });
      }
      botStatus.registered = false;
      botStatus.connected = false;
      botStatus.phone = null;
      botStatus.lastError = null;

      // Restart bot in background — it will pick up pendingPairing
      isStarting = false;
      setTimeout(() => startBot(), 1000);
    }

    const cleanPhone = phone.replace(/[\s\-\(\)\+]/g, '');
    console.log(`📱 Demande de pairing code pour: +${cleanPhone}`);
    console.log(`📱 Socket state: connected=${botStatus.connected}, registered=${botStatus.registered}`);

    // Cancel any previous pending request
    if (pendingPairing) {
      pendingPairing.reject(new Error('Annulé — nouvelle demande.'));
    }

    // Store the pending request — will be resolved when socket is ready
    pendingPairing = { phone: cleanPhone, resolve, reject };

    // Try to handle it immediately if socket exists
    if (sock && !botStatus.connected) {
      await handlePendingPairing();
    }

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingPairing && pendingPairing.phone === cleanPhone) {
        pendingPairing.reject(new Error('Délai d\'attente dépassé. Le bot n\'a pas pu générer le code. Réessayez.'));
        pendingPairing = null;
      }
    }, 30000);
  });
}

// ── Delete Session ──
export function deleteSession() {
  try {
    // Cancel any pending pairing
    if (pendingPairing) {
      pendingPairing.reject(new Error('Session supprimée.'));
      pendingPairing = null;
    }

    if (fs.existsSync('./auth_info')) {
      fs.rmSync('./auth_info', { recursive: true, force: true });
    }
    botStatus.registered = false;
    botStatus.connected = false;
    botStatus.phone = null;
    botStatus.lastError = null;

    // Properly close the socket
    if (sock) {
      try {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('creds.update');
        sock.ev.removeAllListeners('messages.upsert');
        sock.ev.removeAllListeners('group-participants.update');
        sock.end(undefined);
      } catch {}
      sock = null;
    }
    console.log('🗑️ Session supprimée');
    // Reset start guard so startBot() can proceed
    isStarting = false;
    return true;
  } catch (err) {
    console.error('Erreur suppression session:', err.message);
    return false;
  }
}

// ── Get Bot Status ──
export function getBotStatus() {
  return {
    connected: botStatus.connected,
    phone: botStatus.phone,
    registered: botStatus.registered,
    initializing: botStatus.initializing,
    lastError: botStatus.lastError,
    restarts: botStatus.restarts,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
}

// ── Send Command from Web UI ──
export async function sendMessage(commandText, isFromWeb = false) {
  if (!sock) throw new Error('Bot non initialisé. Veuillez patienter...');

  const ownerNum = process.env.OWNER_NUMBER || '224612908366';
  const ownerJid = ownerNum + '@s.whatsapp.net';

  const syntheticMsg = {
    key: {
      remoteJid: ownerJid,
      fromMe: false,
      id: 'WEB-' + Date.now(),
      participant: ownerJid,
    },
    pushName: 'Web Dashboard',
    message: {
      conversation: commandText,
    },
  };

  let capturedResponse = '';
  const originalSend = sock.sendMessage.bind(sock);

  sock.sendMessage = async (jid, content, options) => {
    if (content?.image?.caption) {
      capturedResponse = content.image.caption;
    } else if (content?.text) {
      capturedResponse = content.text;
    } else if (content?.video?.caption) {
      capturedResponse = content.video.caption;
    } else if (content?.document) {
      capturedResponse = 'Document envoyé: ' + (content.fileName || 'fichier');
    }
    return originalSend(jid, content, options);
  };

  try {
    await handleCommand(sock, syntheticMsg, { requestPairingCode, recordingStore, botMode, setBotMode, setTranslationMode, clearTranslationMode, getTranslationMode, translationStore });
  } finally {
    sock.sendMessage = originalSend;
  }

  return capturedResponse || 'Commande exécutée (pas de réponse textuelle)';
}
