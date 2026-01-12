# devo-tribe-azure-meeting-2-notes
Transcription de réunions avec Azure Speech et création d'un C/R avec l'API Claude.

# Meeting → CR

POC minimaliste pour transformer des transcriptions de réunions en comptes-rendus structurés via Claude API.

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

**Coût estimé** : ~0.003$ par CR généré (Sonnet, ~2000 tokens)

## 📁 Structure

```
meeting-transcriber/
├── index.html      # Application complète (HTML + CSS + JS)
├── Dockerfile      # Pour containerisation
└── README.md
```

## 🔧 Fonctionnement

1. L'utilisateur colle une transcription ou upload un .txt
2. Le JS appelle directement l'API Claude depuis le navigateur
3. Claude génère un CR structuré
4. L'utilisateur peut copier le résultat

## ⚠️ Limitations POC

- Pas de backend (clé API exposée côté client - OK pour usage perso)
- Pas de persistence des CR
- Pas d'historique
- Design neutre (à personnaliser)

## 🔜 Évolutions possibles

- [ ] Intégration Azure Speech pour transcription audio
- [ ] Backend Node.js pour sécuriser la clé API
- [ ] Historique des CR (SQLite/PostgreSQL)
- [ ] Export Word/PDF
- [ ] Templates de CR personnalisables