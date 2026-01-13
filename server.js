// server.js - Backend Meeting Transcriber v2 (Claude only, async)
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// Config depuis variables d'environnement (Azure) ou config.js (local)
let CONFIG = {};

if (process.env.BREVO_API_KEY) {
    CONFIG = {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
        AZURE_SPEECH_KEY: process.env.AZURE_SPEECH_KEY || '',
        AZURE_SPEECH_REGION: process.env.AZURE_SPEECH_REGION || 'francecentral',
        AZURE_STORAGE_ACCOUNT: process.env.AZURE_STORAGE_ACCOUNT || '',
        AZURE_STORAGE_KEY: process.env.AZURE_STORAGE_KEY || '',
        AZURE_STORAGE_CONTAINER: process.env.AZURE_STORAGE_CONTAINER || 'audio-uploads',
        BREVO_API_KEY: process.env.BREVO_API_KEY || '',
        EMAIL_FROM: process.env.EMAIL_FROM || 'noreply@devomcloud.fr',
        EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME || 'Meeting Transcriber'
    };
    console.log('✅ Config chargée depuis variables d\'environnement');
} else {
    try {
        let configContent = fs.readFileSync(path.join('/app', 'config.js'), 'utf8');
        configContent = configContent.replace('const CONFIG', 'CONFIG');
        eval(configContent);
        console.log('✅ Config chargée depuis config.js');
    } catch (e) {
        console.error('❌ Erreur chargement config:', e.message);
    }
}

// Charger les prompts
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

// MIME types
const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

// Helper: Parse multipart form data
function parseMultipart(buffer, boundary) {
    const parts = {};
    const boundaryBuffer = Buffer.from('--' + boundary);
    
    let start = buffer.indexOf(boundaryBuffer) + boundaryBuffer.length + 2;
    
    while (start < buffer.length) {
        const end = buffer.indexOf(boundaryBuffer, start);
        if (end === -1) break;
        
        const part = buffer.slice(start, end - 2);
        const headerEnd = part.indexOf('\r\n\r\n');
        const header = part.slice(0, headerEnd).toString();
        const content = part.slice(headerEnd + 4);
        
        const nameMatch = header.match(/name="([^"]+)"/);
        const filenameMatch = header.match(/filename="([^"]+)"/);
        
        if (nameMatch) {
            const name = nameMatch[1];
            if (filenameMatch) {
                parts[name] = {
                    filename: filenameMatch[1],
                    data: content
                };
            } else {
                parts[name] = content.toString();
            }
        }
        
        start = end + boundaryBuffer.length + 2;
    }
    
    return parts;
}

// Helper: Azure Storage SAS URL
function generateSasUrl(blobName) {
    const account = CONFIG.AZURE_STORAGE_ACCOUNT;
    const key = CONFIG.AZURE_STORAGE_KEY;
    const container = CONFIG.AZURE_STORAGE_CONTAINER;
    
    const now = new Date();
    const expiry = new Date(now.getTime() + 60 * 60 * 1000); // 1 heure
    
    const formatDate = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    
    const permissions = 'rcw';
    const startStr = formatDate(now);
    const expiryStr = formatDate(expiry);
    const version = '2020-02-10';
    const resource = 'b';
    const protocol = 'https';
    
    // String to sign pour version 2020-02-10
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
    
    const signature = crypto.createHmac('sha256', Buffer.from(key, 'base64'))
        .update(stringToSign, 'utf8')
        .digest('base64');
    
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

// Helper: Upload blob to Azure
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
                'x-ms-blob-type': 'BlockBlob'
            }
        };
        
        const req = https.request(options, (res) => {
            if (res.statusCode === 201) {
                // Retourner l'URL avec SAS pour que Azure Speech puisse y accéder
                resolve(url);
            } else {
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

// Helper: Azure Speech Batch Transcription
async function createTranscriptionJob(audioUrl) {
    const endpoint = `https://${CONFIG.AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/speechtotext/v3.2/transcriptions`;
    
    const body = JSON.stringify({
        contentUrls: [audioUrl],
        locale: 'fr-FR',
        displayName: `transcription-${Date.now()}`,
        properties: {
            wordLevelTimestampsEnabled: false,
            punctuationMode: 'DictatedAndAutomatic',
            profanityFilterMode: 'None'
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
                'Ocp-Apim-Subscription-Key': CONFIG.AZURE_SPEECH_KEY,
                'Content-Length': Buffer.byteLength(body)
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 201) {
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

// Helper: Poll transcription status
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
                        resolve(result);
                    } else if (result.status === 'Failed') {
                        console.error('❌ Détail erreur transcription:', JSON.stringify(result, null, 2));
                        reject(new Error(`Transcription failed: ${result.properties?.error?.message || 'Unknown error'}`));
                    } else {
                        setTimeout(poll, 5000);
                    }
                });
            });
            
            req.on('error', reject);
            req.end();
        };
        
        poll();
    });
}

// Helper: Get transcription result
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
                const transcriptionFile = files.values.find(f => f.kind === 'Transcription');
                
                if (transcriptionFile) {
                    // Fetch the actual transcription content
                    https.get(transcriptionFile.links.contentUrl, (res2) => {
                        let content = '';
                        res2.on('data', chunk => content += chunk);
                        res2.on('end', () => {
                            const transcription = JSON.parse(content);
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

// Helper: Call Claude API
async function callClaude(transcription, promptType, context) {
    const systemPrompt = PROMPTS[promptType] || PROMPTS['confcall'];
    
    let userMessage = `Voici la transcription. Analyse-la et génère le document structuré approprié.\n\n`;
    if (context) {
        userMessage += `**Contexte fourni :** ${context}\n\n`;
    }
    userMessage += `---\n\n${transcription}`;
    
    const body = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
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

// Helper: Send email via Brevo
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

// Helper: Convert markdown to HTML for email
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

// Main process function (async)
async function processAudio(audioData, filename, type, context, email, subject) {
    console.log(`🚀 Démarrage traitement: ${filename} pour ${email}`);
    
    try {
        // 1. Upload audio to Azure Blob
        const blobName = `${Date.now()}-${filename}`;
        const contentType = filename.endsWith('.mp3') ? 'audio/mpeg' : 
                           filename.endsWith('.m4a') ? 'audio/mp4' : 
                           filename.endsWith('.wav') ? 'audio/wav' : 'audio/ogg';
        
        console.log('📤 Upload vers Azure Blob...');
        const audioUrl = await uploadToAzure(blobName, audioData, contentType);
        console.log('✅ Upload terminé');
        console.log('🔗 URL audio:', audioUrl);
        
        // 2. Create transcription job
        console.log('🎙️ Création job de transcription...');
        const job = await createTranscriptionJob(audioUrl);
        console.log('✅ Job créé:', job.self);
        
        // 3. Poll for completion
        console.log('⏳ Attente transcription...');
        const completed = await pollTranscription(job.self);
        console.log('✅ Transcription terminée');
        
        // 4. Get transcription text
        console.log('📝 Récupération du texte...');
        const transcription = await getTranscriptionResult(completed.links.files);
        console.log(`✅ Texte récupéré (${transcription.length} caractères)`);
        
        // 5. Generate CR with Claude
        console.log('🤖 Génération du compte-rendu avec Claude...');
        const cr = await callClaude(transcription, type, context);
        console.log('✅ Compte-rendu généré');
        
        // 6. Send email
        console.log('📧 Envoi de l\'email...');
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
        console.error('❌ Erreur traitement:', error.message);
        // Envoyer email d'erreur
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

// HTTP Server
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // API endpoint pour le traitement async
    if (req.method === 'POST' && req.url === '/api/process') {
        const contentType = req.headers['content-type'] || '';
        const boundary = contentType.split('boundary=')[1];
        
        if (!boundary) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing boundary' }));
            return;
        }
        
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const parts = parseMultipart(buffer, boundary);
            
            if (!parts.audio || !parts.email) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing audio or email' }));
                return;
            }
            
            // Lancer le traitement en arrière-plan
            processAudio(
                parts.audio.data,
                parts.audio.filename,
                parts.type || 'confcall',
                parts.context || '',
                parts.email,
                parts.subject || 'Compte-rendu de réunion'
            );
            
            // Répondre immédiatement
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Traitement lancé' }));
        });
        
        return;
    }

    // Fichiers statiques
    let filePath = req.url === '/' ? 'index.html' : req.url.substring(1);
    filePath = path.join('/app', filePath);
    
    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    try {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`🚀 Meeting Transcriber v2 running on http://localhost:${PORT}`);
});