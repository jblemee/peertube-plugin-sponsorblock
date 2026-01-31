# Guide de développement

Ce document explique comment développer et tester le plugin PeerTube SponsorBlock.

## Prérequis

- Node.js >= 16
- Une instance PeerTube de développement (>= 6.0.0)
- PostgreSQL (utilisé par PeerTube)
- FFmpeg et ffprobe (requis pour le mode suppression permanente)

## Installation pour le développement

### 1. Cloner le projet

```bash
git clone https://github.com/jblemee/peertube-plugin-sponsorblock.git
cd peertube-plugin-sponsorblock
```

### 2. Installer les dépendances

```bash
npm install
```

### 3. Lier le plugin à votre instance PeerTube

#### Option A : Installation depuis le répertoire local

```bash
# Depuis le répertoire de PeerTube
cd /var/www/peertube

# Installer le plugin
sudo -u peertube NODE_CONFIG_DIR=/var/www/peertube/config NODE_ENV=production npm run plugin:install -- --plugin-path /path/to/peertube-plugin-sponsorblock
```

#### Option B : Symlink pour développement rapide

```bash
# Créer un lien symbolique dans le dossier plugins de PeerTube
ln -s /path/to/peertube-plugin-sponsorblock /var/www/peertube/storage/plugins/node_modules/peertube-plugin-sponsorblock

# Redémarrer PeerTube
sudo systemctl restart peertube
```

### 4. Activer le plugin

1. Aller dans l'interface d'administration PeerTube
2. Naviguer vers **Administration** > **Plugins/Themes**
3. Activer le plugin **SponsorBlock**
4. Configurer les paramètres selon vos besoins

## Structure du projet

```
peertube-plugin-sponsorblock/
├── main.js                 # Point d'entrée serveur (settings, hooks, worker)
├── package.json            # Métadonnées du plugin
├── client/                 # Code client (navigateur)
│   ├── common.js           # Code commun
│   └── video-watch.js      # Lecteur vidéo (skip logic)
├── server/                 # Code serveur
│   ├── routes.js           # API REST (segments, mapping, scan, sync, process)
│   └── ffmpeg.js           # Wrapper FFmpeg/ffprobe (découpe, concat, file discovery)
├── assets/                 # Ressources statiques
│   ├── style.css           # Styles CSS
│   └── images/             # Images
├── languages/              # Traductions
│   ├── en.json             # Anglais
│   └── fr.json             # Français
└── scripts/                # Scripts de build
```

## Architecture

### Flux de données

```
Import YouTube → Hook post-import → Extraction YouTube ID → API SponsorBlock
                                                           ↓
                                                    Cache en DB
                                                     ↓            ↓
                              (mode remove)     (mode skip)
                              Queue processing  Client skip
                                    ↓                  ↓
                              Worker (30s)    API /segments/:uuid → Skip automatique
                                    ↓
                              FFmpeg cut + concat → Remplacement fichier
```

### Tables de base de données

Le plugin crée 3 tables :

1. **`plugin_sponsorblock_mapping`** : Mapping YouTube ID ↔ PeerTube UUID
2. **`plugin_sponsorblock_segments`** : Cache des segments SponsorBlock
3. **`plugin_sponsorblock_processing_queue`** : File d'attente pour le mode "remove"

## Tester le plugin

### 1. Importer une vidéo YouTube

```bash
# Via l'interface web ou CLI
cd /var/www/peertube
sudo -u peertube NODE_CONFIG_DIR=/var/www/peertube/config NODE_ENV=production npm run import-videos -- \
  --target-url "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

### 2. Vérifier le mapping en base de données

```bash
sudo -u postgres psql peertube_prod

SELECT * FROM plugin_sponsorblock_mapping;
SELECT * FROM plugin_sponsorblock_segments;
```

### 3. Tester le skip dans le lecteur

1. Ouvrir la vidéo importée
2. Observer les marqueurs verts sur la barre de progression
3. Laisser la vidéo jouer : les segments devraient être sautés automatiquement
4. Une notification devrait s'afficher à chaque saut

### 4. Tester l'API

```bash
BASE=http://localhost:9000/plugins/sponsorblock/router

# Récupérer les segments d'une vidéo
curl $BASE/segments/{VIDEO_UUID}

# Récupérer le mapping YouTube
curl $BASE/mapping/{VIDEO_UUID}

# Forcer une synchronisation
curl -X POST $BASE/sync/{VIDEO_UUID}

# Lancer le traitement FFmpeg d'une vidéo (admin auth requis)
curl -X POST $BASE/process/{VIDEO_UUID} -H "Authorization: Bearer TOKEN"

# Lancer le traitement de toutes les vidéos non traitées (admin auth requis)
curl -X POST $BASE/process-all -H "Authorization: Bearer TOKEN"
```

### 5. Tester le mode suppression permanente

1. Configurer le mode `remove` dans les paramètres du plugin
2. Vérifier que `storage_path` pointe vers le bon répertoire
3. Vérifier FFmpeg : `ffmpeg -version && ffprobe -version`
4. Importer une vidéo YouTube avec des segments connus
5. Vérifier la file d'attente en DB :
   ```bash
   sudo -u postgres psql peertube_prod -c "SELECT id, video_uuid, status, priority FROM plugin_sponsorblock_processing_queue;"
   ```
6. Le worker traite les jobs toutes les 30s — vérifier les logs pour le suivi

## Développement

### Logs

Les logs du plugin sont visibles dans les logs PeerTube :

```bash
# Suivre les logs en temps réel
sudo journalctl -u peertube -f

# Ou depuis les fichiers de log
tail -f /var/www/peertube/storage/logs/peertube.log
```

### Déboguer le code client

Ouvrir la console développeur du navigateur (F12) :

```javascript
// Les logs du plugin commencent par [SponsorBlock]
console.log('[SponsorBlock] Video loaded')
```

### Recharger le plugin après modifications

```bash
# Redémarrer PeerTube
sudo systemctl restart peertube

# Ou recharger uniquement les plugins (si disponible)
# Via l'interface admin : Plugins > Reload
```

## Développer de nouvelles fonctionnalités

### Ajouter un nouveau hook

Modifier `main.js` :

```javascript
registerHook({
  target: 'action:api.video.updated',
  handler: async (params) => {
    // Votre code ici
  }
})
```

Liste complète des hooks : https://docs.joinpeertube.org/api/plugins

### Ajouter une nouvelle route API

Modifier `server/routes.js` :

```javascript
router.get('/mon-endpoint', async (req, res) => {
  // Votre code ici
  res.json({ success: true })
})
```

### Modifier le comportement client

Modifier `client/video-watch.js` :

```javascript
// Votre code pour interagir avec le lecteur vidéo
player.on('play', () => {
  console.log('Video started playing')
})
```

## Tests

### Tests unitaires (TODO)

```bash
npm test
```

### Tests d'intégration (TODO)

```bash
npm run test:integration
```

## Publication

### Préparer la release

1. Mettre à jour la version dans `package.json`
2. Mettre à jour le `CHANGELOG.md`
3. Créer un tag git :

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

### Publier sur NPM

```bash
npm publish
```

### Soumettre au registry PeerTube

Le plugin sera automatiquement indexé par PeerTube s'il est publié sur NPM avec le préfixe `peertube-plugin-`.

## Ressources

- **Documentation PeerTube** : https://docs.joinpeertube.org/contribute/plugins
- **API SponsorBlock** : https://wiki.sponsor.ajay.app/w/API_Docs
- **Exemple de plugin** : https://github.com/samlich/peertube-plugin-chapters

## Problèmes connus

### Le plugin ne s'active pas

- Vérifier les logs : `sudo journalctl -u peertube -f`
- Vérifier que `engine.peertube` dans `package.json` correspond à votre version
- Vérifier les permissions du répertoire du plugin

### Les segments ne sont pas sautés

- Ouvrir la console développeur (F12)
- Vérifier que les segments sont bien récupérés : `[SponsorBlock] Found X segments to skip`
- Vérifier que l'API retourne les segments : `/plugins/sponsorblock/router/segments/{UUID}`

### Erreur de base de données

- Vérifier que les tables existent : `\dt plugin_sponsorblock*` dans psql
- Supprimer et recréer les tables si nécessaire (attention : perte de données)

## Support

Pour signaler un bug ou demander une fonctionnalité :
https://github.com/jblemee/peertube-plugin-sponsorblock/issues
