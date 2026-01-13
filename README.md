# Meeting Transcriber - Tribe Azure ☁️📝

Transformez vos réunions audio en comptes-rendus structurés grâce à Azure Speech et Claude API.

## 🎯 Fonctionnalités

- **Transcription automatique** : Upload audio → Transcription Azure Speech
- **Génération de CR intelligent** : Claude analyse et structure le compte-rendu
- **6 types de transcription** adaptés :
  - 📝 Note personnelle (dictaphone)
  - 📞 Conversation téléphonique (1:1)
  - 💻 Réunion conf-call / visio
  - 🏢 Réunion en salle (présentiel)
  - 🎓 Conférence (spectateur)
  - 👔 Entretien recrutement (format SmartRecruiter)
- **Workflow async** : Déposez l'audio, recevez le CR par email (~15-20 min)
- **Authentification Entra ID** : Pour accéder à l'application, vous devez être membre d'un groupe Entra ID

## 🏗️ Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Web App Azure  │────▶│  Azure Storage   │────▶│ Azure Speech│
│  (Container)    │     │  (Blob audio)    │     │ (Batch API) │
└────────┬────────┘     └──────────────────┘     └──────┬──────┘
         │                                              │
         │              ┌──────────────────┐            │
         │              │   Claude API     │◀───────────┘
         │              │  (Génération CR) │
         │              └────────┬─────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌──────────────────┐
│   Entra ID      │     │     Brevo       │
│ (Authentification)    │  (Envoi email)   │
└─────────────────┘     └──────────────────┘
```

## 📁 Structure du projet

```
devo-tribe-azure-meeting-2-notes/
├── index.html           # Interface utilisateur
├── styles.css           # Styles couleurs Devoteam
├── server.js            # Backend Node.js (upload, transcription, email)
├── prompts.js           # Prompts Claude par type de transcription
├── config.js            # Configuration locale (clés API) - NE PAS COMMITER (uniquement dév local dans Docker Desktop)
├── config.js.template   # Template de configuration
├── package.json         # Dépendances Node.js
├── Dockerfile           # Image Docker
└── README.md            # Documentation
```

## 🚀 Déploiement

### Prérequis Azure
- Azure Container Registry (ACR)
- Azure Web App for Containers
- Azure Storage Account (container `audio-uploads`)
- Azure Speech Service (région francecentral)
- App Registration Entra ID (pour Easy Auth)

### Variables d'environnement (App Settings)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Clé API Claude |
| `AZURE_SPEECH_KEY` | Clé Azure Speech Service |
| `AZURE_SPEECH_REGION` | Région (ex: francecentral) |
| `AZURE_STORAGE_ACCOUNT` | Nom du Storage Account |
| `AZURE_STORAGE_KEY` | Clé du Storage Account |
| `AZURE_STORAGE_CONTAINER` | Nom du container blob |
| `BREVO_API_KEY` | Clé API Brevo (emails) |
| `EMAIL_FROM` | Adresse expéditeur |
| `EMAIL_FROM_NAME` | Nom expéditeur |

### Build & Push

```bash
# Build l'image
docker build --no-cache -t devo-tribe-azure-meeting-2-notes .

# Tag pour ACR
docker tag devo-tribe-azure-meeting-2-notes azuremeetingtranscriberacr.azurecr.io/meeting-transcriber:latest

# Login ACR
az acr login --name azuremeetingtranscriberacr

# Push
docker push azuremeetingtranscriberacr.azurecr.io/meeting-transcriber:latest
```

Puis **Restart** la Web App dans le portail Azure.

## 💻 Développement local

### Prérequis
- Docker
- Node.js 20+
- Fichier `config.js` avec vos clés

### Lancer en local

```bash
# Avec Docker
docker build -t devo-tribe-azure-meeting-2-notes .
docker run -p 8080:8080 --name meeting-transcriber devo-tribe-azure-meeting-2-notes

# Ouvrir http://localhost:8080
```

### Logs

```bash
docker logs -f devo-tribe-azure-meeting-2-notes
```

## 🔧 Workflow utilisateur

1. 🎙️ Déposer un fichier audio (.mp3, .m4a, .wav, .ogg, .flac)
2. 📋 Sélectionner le type de transcription
3. 💡 Ajouter un contexte optionnel
4. 📧 Saisir son email @devoteam.com
5. 🚀 Cliquer "Recevoir le compte-rendu par email"
6. ✅ Recevoir le CR formaté par email (~15-20 min)

## 🔐 Sécurité

- **Easy Auth** : Authentification Entra ID obligatoire
- **Groupe restreint** : Seuls les membres du groupe `MCLOUD-Meeting-Transcriber-Users` ont accès
- **Email @devoteam.com** : Envoi uniquement vers les adresses Devoteam
- **Clés API** : Stockées dans App Settings Azure (pas dans le code)

## 🔑 Obtenir les clés API

### Claude (Anthropic)
1. https://console.anthropic.com/
2. Créer un compte → "API Keys" → "Create Key"
3. Format : `sk-ant-api03-...`

### Brevo (emails)
1. https://app.brevo.com/
2. SMTP & API → API Keys
3. Utiliser une clé API (pas SMTP)
4. Désactiver la restriction IP si nécessaire

## ⚠️ Limitations

- Fichiers audio < 1h recommandé (temps de traitement)
- Transcription en français uniquement
- POC interne Devoteam M Cloud

## 👤 Contact

Thibault Gibard - thibault.gibard@devoteam.com

---
*Devoteam M Cloud - Tribe Azure - Meeting Transcriber 🤖*