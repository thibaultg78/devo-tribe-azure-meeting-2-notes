// =============================================================================
// SERVER.JS - Backend Meeting Transcriber v2 (Claude only, async)
// =============================================================================
// Application qui transcrit un fichier audio en compte-rendu structuré via :
// 1. Upload du fichier audio vers Azure Blob Storage
// 2. Transcription avec Azure Speech-to-Text (API Batch)
// 3. Génération du compte-rendu avec Claude (Anthropic)
// 4. Envoi par email via Brevo
// =============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// =============================================================================
// SECTION 1 : CHARGEMENT DE LA CONFIGURATION
// =============================================================================
// La config peut provenir de 2 sources :
// - Variables d'environnement (Azure App Service) : détectée via BREVO_API_KEY
// - Fichier config.js (développement local)
// =============================================================================

let CONFIG = {};

if (process.env.BREVO_API_KEY) {
    // ✅ Mode production : chargement depuis variables d'environnement Azure
    CONFIG = {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',         // Clé API Claude
        AZURE_SPEECH_KEY: process.env.AZURE_SPEECH_KEY || '',           // Clé Azure Speech
        AZURE_SPEECH_REGION: process.env.AZURE_SPEECH_REGION || 'francecentral',
        AZURE_STORAGE_ACCOUNT: process.env.AZURE_STORAGE_ACCOUNT || '', // Nom du compte de stockage
        AZURE_STORAGE_KEY: process.env.AZURE_STORAGE_KEY || '',         // Clé d'accès du stockage
        AZURE_STORAGE_CONTAINER: process.env.AZURE_STORAGE_CONTAINER || 'audio-uploads',
        BREVO_API_KEY: process.env.BREVO_API_KEY || '',                 // Clé API Brevo (email)
        EMAIL_FROM: process.env.EMAIL_FROM || 'noreply@devomcloud.fr',
        EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME || 'Tribe Azure - Meeting Transcriber '
    };
    console.log('✅ Config chargée depuis variables d\'environnement');
} else {
    // 🔧 Mode développement : chargement depuis config.js
    try {
        let configContent = fs.readFileSync(path.join('/app', 'config.js'), 'utf8');
        configContent = configContent.replace('const CONFIG', 'CONFIG');
        eval(configContent);
        console.log('✅ Config chargée depuis config.js');
    } catch (e) {
        console.error('❌ Erreur chargement config:', e.message);
    }
}

// =============================================================================
// SECTION 2 : CHARGEMENT DES PROMPTS CLAUDE
// =============================================================================
// Les prompts définissent les instructions système pour Claude selon le type
// de document à générer (confcall, interview, brainstorm, etc.)
// =============================================================================

let PROMPTS = {};
try {
    let promptsContent = fs.readFileSync(path.join('/app', 'prompts.js'), 'utf8');
    promptsContent = promptsContent.replace('const PROMPTS', 'PROMPTS');
    eval(promptsContent);
    console.log('✅ Prompts chargés');
} catch (e) {
    console.error('❌ Erreur chargement prompts:', e.message);
}

const PORT = process.env.PORT || 8080;

// =============================================================================
// SECTION 3 : CONFIGURATION DES TYPES MIME
// =============================================================================
// Types MIME pour servir les fichiers statiques (HTML, CSS, JS, images)
// =============================================================================

const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

// =============================================================================
// SECTION 4 : HELPER - PARSING MULTIPART/FORM-DATA
// =============================================================================
/**
 * Parse les données multipart/form-data envoyées depuis le frontend
 * Extrait les champs texte et les fichiers uploadés
 * 
 * @param {Buffer} buffer - Données brutes de la requête
 * @param {string} boundary - Séparateur multipart (extrait du Content-Type)
 * @returns {Object} Objet contenant les champs parsés
 */
// =============================================================================

function parseMultipart(buffer, boundary) {
    const parts = {};
    const boundaryBuffer = Buffer.from('--' + boundary);
    
    // Position du début du premier bloc de données
    let start = buffer.indexOf(boundaryBuffer) + boundaryBuffer.length + 2;
    
    // Boucle sur chaque partie du multipart
    while (start < buffer.length) {
        const end = buffer.indexOf(boundaryBuffer, start);
        if (end === -1) break;
        
        // Extraction de la partie (headers + contenu)
        const part = buffer.slice(start, end - 2);
        const headerEnd = part.indexOf('\r\n\r\n');
        const header = part.slice(0, headerEnd).toString();
        const content = part.slice(headerEnd + 4);
        
        // Extraction du nom du champ et éventuellement du nom de fichier
        const nameMatch = header.match(/name="([^"]+)"/);
        const filenameMatch = header.match(/filename="([^"]+)"/);
        
        if (nameMatch) {
            const name = nameMatch[1];
            if (filenameMatch) {
                // C'est un fichier uploadé
                parts[name] = {
                    filename: filenameMatch[1],
                    data: content
                };
            } else {
                // C'est un champ texte
                parts[name] = content.toString();
            }
        }
        
        start = end + boundaryBuffer.length + 2;
    }
    
    return parts;
}

// =============================================================================
// SECTION 5 : HELPER - GÉNÉRATION D'URL SAS AZURE BLOB
// =============================================================================
/**
 * Génère une URL signée (SAS) pour accéder temporairement à un blob Azure
 * Nécessaire pour que Azure Speech puisse lire le fichier audio uploadé
 * 
 * @param {string} blobName - Nom du fichier dans le conteneur
 * @returns {string} URL complète avec token SAS (valide 1 heure)
 */
// =============================================================================

function generateSasUrl(blobName) {
    const account = CONFIG.AZURE_STORAGE_ACCOUNT;
    const key = CONFIG.AZURE_STORAGE_KEY;
    const container = CONFIG.AZURE_STORAGE_CONTAINER;
    
    // Définir la période de validité du token (1 heure)
    const now = new Date();
    const expiry = new Date(now.getTime() + 60 * 60 * 1000);
    
    const formatDate = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    
    // Paramètres du token SAS
    const permissions = 'rcw'; // read, create, write
    const startStr = formatDate(now);
    const expiryStr = formatDate(expiry);
    const version = '2020-02-10';
    const resource = 'b'; // blob
    const protocol = 'https';
    
    // Construction de la chaîne à signer (ordre strict requis par Azure)
    const stringToSign = [
        permissions,
        startStr,
        expiryStr,
        `/blob/${account}/${container}/${blobName}`,
        '', // signedIdentifier
        '', // signedIP
        protocol,
        version,
        resource,
        '', // signedSnapshotTime
        '', // rscc (Cache-Control)
        '', // rscd (Content-Disposition)
        '', // rsce (Content-Encoding)
        '', // rscl (Content-Language)
        ''  // rsct (Content-Type)
    ].join('\n');
    
    // Signature HMAC-SHA256 avec la clé du compte de stockage
    const signature = crypto.createHmac('sha256', Buffer.from(key, 'base64'))
        .update(stringToSign, 'utf8')
        .digest('base64');
    
    // Construction du token SAS complet
    const sasToken = [
        `sv=${version}`,
        `st=${encodeURIComponent(startStr)}`,
        `se=${encodeURIComponent(expiryStr)}`,
        `sr=${resource}`,
        `sp=${permissions}`,
        `spr=${protocol}`,
        `sig=${encodeURIComponent(signature)}`
    ].join('&');
    
    return `https://${account}.blob.core.windows.net/${container}/${blobName}?${sasToken}`;
}

// =============================================================================
// SECTION 6 : HELPER - UPLOAD VERS AZURE BLOB STORAGE
// =============================================================================
/**
 * Upload un fichier audio vers Azure Blob Storage via requête HTTPS PUT
 * Utilise l'URL SAS générée pour authentifier la requête
 * 
 * @param {string} blobName - Nom du blob à créer
 * @param {Buffer} data - Données binaires du fichier audio
 * @param {string} contentType - Type MIME du fichier (audio/mpeg, audio/mp4, etc.)
 * @returns {Promise<string>} URL complète du blob avec SAS
 */
// =============================================================================

async function uploadToAzure(blobName, data, contentType) {
    const url = generateSasUrl(blobName);
    
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: 'PUT',
            headers: {
                'Content-Type': contentType,
                'Content-Length': data.length,
                'x-ms-blob-type': 'BlockBlob' // Type de blob standard Azure
            }
        };
        
        const req = https.request(options, (res) => {
            if (res.statusCode === 201) {
                // Upload réussi : retourner l'URL avec SAS
                resolve(url);
            } else {
                // Erreur : récupérer le corps de la réponse pour diagnostic
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => reject(new Error(`Upload failed: ${res.statusCode} - ${body}`)));
            }
        });
        
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// =============================================================================
// SECTION 7 : HELPER - CRÉATION JOB DE TRANSCRIPTION AZURE SPEECH
// =============================================================================
/**
 * Crée un job de transcription Batch via l'API Azure Speech-to-Text v3.2
 * Mode asynchrone : adapté aux fichiers audio longs (> 1 minute)
 * 
 * @param {string} audioUrl - URL du fichier audio (avec SAS) accessible par Azure
 * @returns {Promise<Object>} Objet contenant l'URL du job créé (propriété "self")
 */
// =============================================================================

async function createTranscriptionJob(audioUrl) {
    const endpoint = `https://${CONFIG.AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/speechtotext/v3.2/transcriptions`;
    
    // Configuration du job de transcription
    const body = JSON.stringify({
        contentUrls: [audioUrl], // URL(s) des fichiers audio à transcrire
        locale: 'fr-FR',         // Langue française
        displayName: `transcription-${Date.now()}`,
        properties: {
            wordLevelTimestampsEnabled: false,        // Pas besoin de timestamps par mot
            punctuationMode: 'DictatedAndAutomatic',  // Ponctuation automatique
            profanityFilterMode: 'None'               // Pas de filtre de gros mots
        }
    });
    
    return new Promise((resolve, reject) => {
        const urlObj = new URL(endpoint);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Ocp-Apim-Subscription-Key': CONFIG.AZURE_SPEECH_KEY, // Authentification
                'Content-Length': Buffer.byteLength(body)
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 201) {
                    // Job créé avec succès
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(`Transcription job failed: ${res.statusCode} - ${data}`));
                }
            });
        });
        
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// =============================================================================
// SECTION 8 : HELPER - POLLING DU STATUT DE TRANSCRIPTION
// =============================================================================
/**
 * Vérifie régulièrement (toutes les 5s) le statut du job de transcription
 * Attend que le statut passe à "Succeeded" ou "Failed"
 * 
 * @param {string} selfUrl - URL du job de transcription (ex: .../transcriptions/{id})
 * @returns {Promise<Object>} Objet complet du job une fois terminé
 */
// =============================================================================

async function pollTranscription(selfUrl) {
    return new Promise((resolve, reject) => {
        const poll = () => {
            const urlObj = new URL(selfUrl);
            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname,
                method: 'GET',
                headers: {
                    'Ocp-Apim-Subscription-Key': CONFIG.AZURE_SPEECH_KEY
                }
            };
            
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const result = JSON.parse(data);
                    console.log('📊 Status transcription:', result.status);
                    
                    if (result.status === 'Succeeded') {
                        // Transcription terminée avec succès
                        resolve(result);
                    } else if (result.status === 'Failed') {
                        // Erreur de transcription : afficher détails
                        console.error('❌ Détail erreur transcription:', JSON.stringify(result, null, 2));
                        reject(new Error(`Transcription failed: ${result.properties?.error?.message || 'Unknown error'}`));
                    } else {
                        // Statut "Running" ou "NotStarted" : attendre 5s et réessayer
                        setTimeout(poll, 5000);
                    }
                });
            });
            
            req.on('error', reject);
            req.end();
        };
        
        poll(); // Lancer le premier poll immédiatement
    });
}

// =============================================================================
// SECTION 9 : HELPER - RÉCUPÉRATION DU TEXTE TRANSCRIT
// =============================================================================
/**
 * Récupère le fichier JSON contenant la transcription finale
 * Parse le JSON pour extraire le texte complet
 * 
 * @param {string} filesUrl - URL de l'endpoint listant les fichiers du job
 * @returns {Promise<string>} Texte transcrit (combinaison de toutes les phrases)
 */
// =============================================================================

async function getTranscriptionResult(filesUrl) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(filesUrl);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname,
            method: 'GET',
            headers: {
                'Ocp-Apim-Subscription-Key': CONFIG.AZURE_SPEECH_KEY
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', async () => {
                const files = JSON.parse(data);
                // Chercher le fichier de type "Transcription" (vs "Report")
                const transcriptionFile = files.values.find(f => f.kind === 'Transcription');
                
                if (transcriptionFile) {
                    // Télécharger le contenu du fichier de transcription
                    https.get(transcriptionFile.links.contentUrl, (res2) => {
                        let content = '';
                        res2.on('data', chunk => content += chunk);
                        res2.on('end', () => {
                            const transcription = JSON.parse(content);
                            // Extraire et concaténer toutes les phrases reconnues
                            const text = transcription.combinedRecognizedPhrases
                                ?.map(p => p.display)
                                .join('\n') || '';
                            resolve(text);
                        });
                    });
                } else {
                    reject(new Error('No transcription file found'));
                }
            });
        });
        
        req.on('error', reject);
        req.end();
    });
}

// =============================================================================
// SECTION 10 : HELPER - APPEL À L'API CLAUDE (ANTHROPIC)
// =============================================================================
/**
 * Envoie la transcription à Claude pour générer un compte-rendu structuré
 * Utilise un prompt système selon le type de document souhaité
 * 
 * @param {string} transcription - Texte brut de la transcription
 * @param {string} promptType - Type de prompt à utiliser (confcall, interview, etc.)
 * @param {string} context - Contexte additionnel fourni par l'utilisateur (optionnel)
 * @returns {Promise<string>} Compte-rendu formaté en Markdown
 */
// =============================================================================

async function callClaude(transcription, promptType, context) {
    // Sélectionner le prompt système approprié
    const systemPrompt = PROMPTS[promptType] || PROMPTS['confcall'];
    
    // Construction du message utilisateur
    let userMessage = `Voici la transcription. Analyse-la et génère le document structuré approprié.\n\n`;
    if (context) {
        userMessage += `**Contexte fourni :** ${context}\n\n`;
    }
    userMessage += `---\n\n${transcription}`;
    
    // Payload de la requête API
    const body = JSON.stringify({
        model: 'claude-sonnet-4-20250514', // Modèle Claude Sonnet 4 (dernière version)
        max_tokens: 4096,                   // Nombre max de tokens en sortie
        system: systemPrompt,               // Instructions système
        messages: [{ role: 'user', content: userMessage }]
    });
    
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CONFIG.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(body)
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    const result = JSON.parse(data);
                    // Extraire le texte généré (premier élément du tableau "content")
                    resolve(result.content[0].text);
                } else {
                    reject(new Error(`Claude API failed: ${res.statusCode} - ${data}`));
                }
            });
        });
        
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// =============================================================================
// SECTION 11 : HELPER - ENVOI D'EMAIL VIA BREVO
// =============================================================================
/**
 * Envoie un email via l'API Brevo (ex-Sendinblue)
 * 
 * @param {string} to - Adresse email du destinataire
 * @param {string} subject - Sujet de l'email
 * @param {string} htmlContent - Corps de l'email au format HTML
 * @returns {Promise<Object>} Réponse de l'API Brevo
 */
// =============================================================================

async function sendEmail(to, subject, htmlContent) {
    const body = JSON.stringify({
        sender: { name: CONFIG.EMAIL_FROM_NAME, email: CONFIG.EMAIL_FROM },
        to: [{ email: to }],
        subject: subject,
        htmlContent: htmlContent
    });
    
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.brevo.com',
            path: '/v3/smtp/email',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': CONFIG.BREVO_API_KEY,
                'Content-Length': Buffer.byteLength(body)
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 201) {
                    // Email envoyé avec succès
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(`Brevo failed: ${res.statusCode} - ${data}`));
                }
            });
        });
        
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// =============================================================================
// SECTION 12 : HELPER - CONVERSION MARKDOWN → HTML
// =============================================================================
/**
 * Convertit le Markdown généré par Claude en HTML stylisé pour l'email
 * Gère les titres, listes, gras, italique, etc.
 * 
 * @param {string} markdown - Texte au format Markdown
 * @returns {string} HTML avec styles inline pour email
 */
// =============================================================================

function markdownToHtml(markdown) {
    return markdown
        .replace(/^### (.*$)/gim, '<h3 style="color:#1f2937;margin-top:20px;">$1</h3>')
        .replace(/^## (.*$)/gim, '<h2 style="color:#1f2937;margin-top:25px;border-bottom:1px solid #e5e7eb;padding-bottom:5px;">$1</h2>')
        .replace(/^# (.*$)/gim, '<h1 style="color:#1f2937;">$1</h1>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/^- (.*$)/gim, '<li style="margin:5px 0;">$1</li>')
        .replace(/^☐ (.*$)/gim, '<li style="margin:5px 0;">☐ $1</li>')
        .replace(/(<li.*<\/li>)/s, '<ul style="margin:10px 0;padding-left:20px;">$1</ul>')
        .replace(/\n\n/g, '</p><p style="margin:10px 0;">')
        .replace(/\n/g, '<br>');
}

// =============================================================================
// SECTION 13 : FONCTION PRINCIPALE - TRAITEMENT COMPLET
// =============================================================================
/**
 * Orchestre l'ensemble du workflow de traitement audio → email
 * Appelée de manière asynchrone (non-bloquante) depuis le endpoint /api/process
 * 
 * Étapes :
 * 1. Upload du fichier audio vers Azure Blob Storage
 * 2. Création d'un job de transcription Azure Speech
 * 3. Polling du statut jusqu'à complétion
 * 4. Récupération du texte transcrit
 * 5. Génération du compte-rendu avec Claude
 * 6. Envoi du résultat par email via Brevo
 * 
 * En cas d'erreur à n'importe quelle étape, un email d'erreur est envoyé
 * 
 * @param {Buffer} audioData - Données binaires du fichier audio
 * @param {string} filename - Nom du fichier uploadé
 * @param {string} type - Type de document à générer (confcall, interview, etc.)
 * @param {string} context - Contexte additionnel fourni par l'utilisateur
 * @param {string} email - Adresse email du destinataire
 * @param {string} subject - Sujet de l'email
 */
// =============================================================================

async function processAudio(audioData, filename, type, context, email, subject) {
    console.log(`🚀 Démarrage traitement: ${filename} pour ${email}`);
    
    try {
        // --- ÉTAPE 1 : UPLOAD VERS AZURE BLOB ---
        const blobName = `${Date.now()}-${filename}`;
        // Déterminer le type MIME selon l'extension du fichier
        const contentType = filename.endsWith('.mp3') ? 'audio/mpeg' : 
                           filename.endsWith('.m4a') ? 'audio/mp4' : 
                           filename.endsWith('.wav') ? 'audio/wav' : 'audio/ogg';
        
        console.log('📤 Upload vers Azure Blob...');
        const audioUrl = await uploadToAzure(blobName, audioData, contentType);
        console.log('✅ Upload terminé');
        console.log('🔗 URL audio:', audioUrl);
        
        // --- ÉTAPE 2 : CRÉATION JOB DE TRANSCRIPTION ---
        console.log('🎙️ Création job de transcription...');
        const job = await createTranscriptionJob(audioUrl);
        console.log('✅ Job créé:', job.self);
        
        // --- ÉTAPE 3 : ATTENTE DE LA TRANSCRIPTION ---
        console.log('⏳ Attente transcription...');
        const completed = await pollTranscription(job.self);
        console.log('✅ Transcription terminée');
        
        // --- ÉTAPE 4 : RÉCUPÉRATION DU TEXTE ---
        console.log('📝 Récupération du texte...');
        const transcription = await getTranscriptionResult(completed.links.files);
        console.log(`✅ Texte récupéré (${transcription.length} caractères)`);
        
        // --- ÉTAPE 5 : GÉNÉRATION DU COMPTE-RENDU AVEC CLAUDE ---
        console.log('🤖 Génération du compte-rendu avec Claude...');
        const cr = await callClaude(transcription, type, context);
        console.log('✅ Compte-rendu généré');
        
        // --- ÉTAPE 6 : ENVOI DE L'EMAIL ---
        console.log('📧 Envoi de l\'email...');
        // Construction du template HTML de l'email
        const htmlContent = `
            <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px;">
                <div style="background: linear-gradient(135deg, #1f2937 0%, #374151 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0;">
                    <h1 style="margin:0; font-size: 1.3rem;">☁️ Tribe Azure - Meeting Transcriber 📝</h1>
                </div>
                <div style="padding: 20px; background: #f9fafb; border: 1px solid #e5e7eb; border-top: none;">
                    ${markdownToHtml(cr)}
                </div>
                <div style="padding: 15px; background: #f3f4f6; border-radius: 0 0 10px 10px; text-align: center; font-size: 0.8rem; color: #6b7280;">
                    Généré automatiquement par Meeting Transcriber - Devoteam M Cloud
                </div>
            </div>
        `;
        
        await sendEmail(email, subject, htmlContent);
        console.log(`✅ Email envoyé à ${email}`);
        
    } catch (error) {
        // --- GESTION DES ERREURS ---
        console.error('❌ Erreur traitement:', error.message);
        // Tenter d'envoyer un email d'erreur à l'utilisateur
        try {
            await sendEmail(email, `[ERREUR] ${subject}`, `
                <div style="font-family: Arial, sans-serif; padding: 20px;">
                    <h2 style="color: #dc2626;">❌ Erreur lors du traitement</h2>
                    <p>Une erreur s'est produite lors du traitement de votre fichier audio.</p>
                    <p><strong>Erreur:</strong> ${error.message}</p>
                    <p>Veuillez réessayer ou contacter le support.</p>
                </div>
            `);
        } catch (e) {
            console.error('❌ Erreur envoi email d\'erreur:', e.message);
        }
    }
}

// =============================================================================
// SECTION 14 : SERVEUR HTTP
// =============================================================================
// Serveur HTTP qui gère :
// - L'endpoint API /api/process pour le traitement audio
// - Le service de fichiers statiques (HTML, CSS, JS)
// =============================================================================

const server = http.createServer(async (req, res) => {
    // Configuration CORS pour permettre les requêtes depuis le frontend
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Répondre aux requêtes OPTIONS (preflight CORS)
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // --- ENDPOINT API : /api/process ---
    // Point d'entrée pour le traitement audio asynchrone
    if (req.method === 'POST' && req.url === '/api/process') {
        const contentType = req.headers['content-type'] || '';
        const boundary = contentType.split('boundary=')[1];
        
        if (!boundary) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing boundary' }));
            return;
        }
        
        // Réception des données multipart
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const parts = parseMultipart(buffer, boundary);
            
            // Validation des champs obligatoires
            if (!parts.audio || !parts.email) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing audio or email' }));
                return;
            }
            
            // Lancer le traitement en arrière-plan (non bloquant)
            processAudio(
                parts.audio.data,
                parts.audio.filename,
                parts.type || 'confcall',
                parts.context || '',
                parts.email,
                parts.subject || 'Compte-rendu de réunion'
            );
            
            // Répondre immédiatement au client (ne pas attendre la fin du traitement)
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Traitement lancé' }));
        });
        
        return;
    }

    // --- SERVEUR DE FICHIERS STATIQUES ---
    // Sert les fichiers HTML, CSS, JS, images, etc.
    let filePath = req.url === '/' ? 'index.html' : req.url.substring(1);
    filePath = path.join('/app', filePath);
    
    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    try {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    } catch (e) {
        // Fichier non trouvé
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// =============================================================================
// DÉMARRAGE DU SERVEUR
// =============================================================================

server.listen(PORT, () => {
    console.log(`🚀 Meeting Transcriber v2 running on http://localhost:${PORT}`);
});