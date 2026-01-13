# devo-tribe-azure-meeting-2-notes
Transcription de réunions avec Azure Speech et création d'un C/R avec l'API Claude.

# Meeting → CR

POC minimaliste pour transformer des transcriptions de réunions en comptes-rendus structurés via Azure Speech & Claude API.

## 🚀 Lancer en local

### Option 1 : Ouvrir directement le HTML
```bash
# Simplement ouvrir index.html dans un navigateur
open index.html  # macOS
start index.html # Windows
```

### Option 2 : Docker
```bash
docker build -t meeting-cr .
docker run -p 8080:80 meeting-cr
# Puis ouvrir http://localhost:8080
```

## 🔑 Obtenir une clé API Claude

1. Aller sur https://console.anthropic.com/
2. Créer un compte (séparé de l'abonnement Claude Pro)
3. Aller dans "API Keys" → "Create Key"
4. Copier la clé (format `sk-ant-api03-...`)
5. Ajouter du crédit (Pay-as-you-go, minimum ~5$)

## 📁 Structure

```
devo-tribe-azure-meeting-2-notes/
├── index.html           # Application web complète (HTML + CSS + JS)
├── script.js            # Logique JavaScript (API Claude, gestion UI)
├── style.css            # Styles et thème de l'application
├── config.js            # Configuration (clé API Claude ou ChatGPT)
├── config.example.js    # Exemple de template de configuration
├── prompt.js            # Configuration du prompt à envoyer à Claude
├── Dockerfile           # Configuration Docker pour déploiement
├── .dockerignore        # Fichiers à exclure du build Docker
├── .gitignore           # Fichiers à exclure de Git
└── README.md            # Documentation du projet
```

## 🔧 Fonctionnement

1. L'utilisateur importe un fichier audio d'une réunion qui été enregistrée
2. Le fichier est stocké dans un Storage Account pour être transcrit en texte avec Azure Speech
3. La transcription texte est récupérée dans l'application
4. Le JS appelle directement l'API Claude depuis le navigateur
5. Claude génère un CR structuré
6. L'utilisateur peut copier son compte-rendu pour le modifier ou l'envoyer

## ⚠️ Limitations POC

- Pas de backend (clé API exposée côté client - pensé pour usage perso)
- Les fichiers audio restent sauvegardés dans le Storage Account dans Azure
- Design Devoteam (Tribe Azure)