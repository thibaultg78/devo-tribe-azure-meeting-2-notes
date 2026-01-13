// server.js - Backend pour l'envoi d'email via Brevo
const http = require('http');
const fs = require('fs');
const path = require('path');

// Charger config.js
let CONFIG = {};
try {
    let configContent = fs.readFileSync(path.join('/app', 'config.js'), 'utf8');
    // Remplacer "const CONFIG" par "CONFIG" pour que l'eval fonctionne
    configContent = configContent.replace('const CONFIG', 'CONFIG');
    eval(configContent);
    // Debug supprimé
    //console.log('✅ Config chargée, BREVO_API_KEY:', CONFIG.BREVO_API_KEY ? 'présente' : 'MANQUANTE');
} catch (e) {
    console.error('❌ Erreur chargement config.js:', e.message);
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

// Serveur HTTP
const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // API endpoint pour l'envoi d'email
    if (req.method === 'POST' && req.url === '/api/send-email') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { to, subject, htmlContent, textContent } = JSON.parse(body);

                if (!to || !subject || !htmlContent) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: 'Paramètres manquants' }));
                    return;
                }

                // Appel API Brevo
                const brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
                    method: 'POST',
                    headers: {
                        'accept': 'application/json',
                        'api-key': CONFIG.BREVO_API_KEY,
                        'content-type': 'application/json'
                    },
                    body: JSON.stringify({
                        sender: {
                            name: CONFIG.EMAIL_FROM_NAME || 'Meeting Transcriber',
                            email: CONFIG.EMAIL_FROM || 'noreply@devomcloud.fr'
                        },
                        to: [{ email: to }],
                        subject: subject,
                        htmlContent: `
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <style>
                                    body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
                                    h1, h2, h3 { color: #1f2937; }
                                    h1 { font-size: 1.5em; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px; }
                                    h2 { font-size: 1.2em; margin-top: 1.5em; }
                                    ul, ol { margin: 0.5em 0; padding-left: 1.5em; }
                                    li { margin: 0.3em 0; }
                                    strong { color: #374151; }
                                    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; font-size: 0.85em; color: #6b7280; }
                                </style>
                            </head>
                            <body>
                                ${htmlContent}
                                <div class="footer">
                                    <p>📝 Généré par Meeting Transcriber - Devoteam M Cloud - Tribe Azure</p>
                                </div>
                            </body>
                            </html>
                        `,
                        textContent: textContent || ''
                    })
                });

                if (!brevoResponse.ok) {
                    const error = await brevoResponse.json();
                    console.error('Erreur Brevo:', error);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: error.message || 'Erreur envoi Brevo' }));
                    return;
                }

                console.log(`✅ Email envoyé à ${to}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));

            } catch (error) {
                console.error('Erreur:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: error.message }));
            }
        });
        return;
    }

    // Servir les fichiers statiques (depuis /app)
    let filePath = req.url === '/' ? 'index.html' : req.url.substring(1);
    filePath = path.join('/app', filePath);

    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('404 Not Found');
            } else {
                res.writeHead(500);
                res.end('Server Error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Meeting Transcriber running on http://localhost:${PORT}`);
});