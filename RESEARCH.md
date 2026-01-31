# Recherche : Plugin SponsorBlock pour PeerTube

**Date de recherche** : 2026-01-31
**Objectif** : Créer un plugin PeerTube qui intègre SponsorBlock pour sauter (ou supprimer) automatiquement les segments sponsorisés des vidéos importées depuis YouTube.

---

## Table des matières

1. [Contexte](#contexte)
2. [État de l'art](#état-de-lart)
3. [Capacités du système de plugins PeerTube](#capacités-du-système-de-plugins-peertube)
4. [Architecture proposée](#architecture-proposée)
5. [Défis techniques](#défis-techniques)
6. [Approches possibles](#approches-possibles)
7. [Ressources](#ressources)

---

## Contexte

### Qu'est-ce que SponsorBlock ?

SponsorBlock est un système **crowdsourcé** qui permet de sauter automatiquement les segments sponsorisés dans les vidéos YouTube. Les utilisateurs soumettent manuellement les timestamps des segments indésirables :
- Sponsorships (placements de produits)
- Intros/outros
- Rappels d'abonnement
- Auto-promotions
- Segments non musicaux dans les vidéos musicales

Ces données sont stockées dans une base de données centralisée accessible via API : `https://sponsor.ajay.app/api/`

### Le problème

PeerTube ne supporte pas nativement SponsorBlock. Les vidéos importées depuis YouTube contiennent toujours les segments sponsorisés, même si SponsorBlock a déjà identifié ces segments dans la base de données.

### Use case spécifique

Les vidéos sont importées dans PeerTube :
- Soit manuellement via URL YouTube
- Soit automatiquement via synchronisation de chaîne YouTube

Dans ces cas, **l'ID YouTube original est connu** et peut être utilisé pour interroger l'API SponsorBlock.

---

## État de l'art

### Projets existants

#### 1. **peertube-plugin-chapters**
- **URL** : https://github.com/samlich/peertube-plugin-chapters
- **NPM** : https://www.npmjs.com/package/peertube-plugin-chapters
- **Statut** : Dernière publication il y a 3 ans (v1.1.3)
- **Fonctionnalité** : Permet d'ajouter manuellement des chapitres aux vidéos avec des tags similaires à SponsorBlock ("Sponsor", "Self-promotion", etc.)
- **Limitation** :
  - Saisie **manuelle** uniquement
  - Pas de connexion à la base de données SponsorBlock
  - Devait être obsolète selon la roadmap PeerTube 2023

#### 2. **Tubular (Android)**
- **URL** : https://alternativeto.net/software/newpipe-x-sponsorblock/about/
- **Fonctionnalité** : Client Android qui combine SponsorBlock et support PeerTube
- **Limitation** : Application mobile, pas un plugin serveur

### Feature requests ouvertes

Plusieurs demandes depuis **2020** restent non implémentées :
- [Issue #1209](https://github.com/ajayyy/SponsorBlock/issues/1209) - Add peertube support (2022)
- [Issue #1938](https://github.com/ajayyy/SponsorBlock/issues/1938) - Lack of PeerTube Support
- [Issue #993](https://github.com/ajayyy/SponsorBlock/issues/993) - PeerTube Support (2020)
- [Issue #515](https://github.com/ajayyy/SponsorBlock/issues/515) - Expand integration beyond YouTube

### Conclusion

**Aucun plugin SponsorBlock natif pour PeerTube n'existe actuellement.**

---

## Capacités du système de plugins PeerTube

### Documentation officielle

- **Guide des plugins** : https://docs.joinpeertube.org/contribute/plugins
- **API de référence** : https://docs.joinpeertube.org/api/plugins
- **API Embed** : https://docs.joinpeertube.org/api/embed-player

### Système de hooks

PeerTube utilise un système de hooks en 3 types :
1. **Filter hooks** : Modifient les paramètres ou valeurs de retour
2. **Action hooks** : Exécutent du code après un événement
3. **Static hooks** : Comme les action hooks mais PeerTube attend leur exécution

### Hooks pertinents pour SponsorBlock

#### Hooks d'import de vidéos

```javascript
// Avant import
'filter:api.video.pre-import-url.accept.result'
'filter:api.video.pre-import-torrent.accept.result'

// Après import
'filter:api.video.post-import-url.accept.result'
'filter:api.video.post-import-torrent.accept.result'

// Modification des attributs lors de l'import
'filter:api.video.import-url.video-attribute.result'
'filter:api.video.import-torrent.video-attribute.result'

// Import utilisateur (PeerTube ≥ 6.1)
'filter:api.video.user-import.accept.result'
'filter:api.video.user-import.video-attribute.result'
```

#### Hooks du lecteur vidéo

```javascript
// Vidéo chargée dans le lecteur
'action:video-watch.video.loaded'

// Événements de lecture
'action:api.video.uploaded'
'action:api.video.updated'
```

### Accès à la base de données

Les plugins peuvent accéder à la base de données PostgreSQL via `peertubeHelpers.database` :

```javascript
async function register ({ peertubeHelpers }) {
  const database = peertubeHelpers.database;

  // Exécuter des requêtes SQL brutes
  const [results, _] = await database.query(`
    SELECT "videoId" as id, name FROM video WHERE ...
  `);

  // Créer des tables personnalisées
  await database.query(`
    CREATE TABLE IF NOT EXISTS plugin_my_table (
      id SERIAL PRIMARY KEY,
      data JSONB
    );
  `);
}
```

### Stockage de données

Deux options :
1. **PluginStorageManager** : Stockage clé-valeur JSON dans la DB PeerTube
2. **Tables personnalisées** : Via requêtes SQL directes

### Accès aux APIs externes

Les plugins peuvent faire des requêtes HTTP externes pour interroger des APIs comme SponsorBlock.

### Modification de l'interface

- Injection de CSS et fichiers statiques
- Modification du lecteur vidéo et de ses contrôles
- Ajout de routes et pages personnalisées

---

## Architecture proposée

### Composants du plugin

#### 1. Table de mapping YouTube ID ↔ PeerTube UUID

```sql
CREATE TABLE IF NOT EXISTS plugin_sponsorblock_mapping (
  peertube_uuid UUID PRIMARY KEY REFERENCES video(uuid) ON DELETE CASCADE,
  youtube_id VARCHAR(11) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  last_sync TIMESTAMP
);

CREATE INDEX idx_youtube_id ON plugin_sponsorblock_mapping(youtube_id);
```

#### 2. Cache local des segments SponsorBlock

```sql
CREATE TABLE IF NOT EXISTS plugin_sponsorblock_segments (
  id SERIAL PRIMARY KEY,
  youtube_id VARCHAR(11) NOT NULL,
  segment_uuid UUID NOT NULL,
  start_time FLOAT NOT NULL,
  end_time FLOAT NOT NULL,
  category VARCHAR(50) NOT NULL,
  action_type VARCHAR(20) NOT NULL,
  votes INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_segments_youtube_id ON plugin_sponsorblock_segments(youtube_id);
```

#### 3. Hook d'import pour capturer l'ID YouTube

```javascript
registerHook({
  target: 'filter:api.video.post-import-url.accept.result',
  handler: async (result, params) => {
    const { videoImport } = params;
    const targetUrl = videoImport.targetUrl;

    // Extraire l'ID YouTube
    const youtubeId = extractYouTubeId(targetUrl);

    if (youtubeId && videoImport.video) {
      // Sauvegarder le mapping
      await database.query(`
        INSERT INTO plugin_sponsorblock_mapping (peertube_uuid, youtube_id)
        VALUES ($1, $2)
        ON CONFLICT (peertube_uuid) DO NOTHING
      `, [videoImport.video.uuid, youtubeId]);

      // Récupérer et cacher les segments SponsorBlock
      await fetchAndCacheSegments(youtubeId);
    }

    return result;
  }
});
```

#### 4. Fonction d'extraction d'ID YouTube

```javascript
function extractYouTubeId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/v\/([a-zA-Z0-9_-]{11})/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}
```

#### 5. Récupération des segments SponsorBlock

```javascript
async function fetchAndCacheSegments(youtubeId) {
  try {
    const response = await fetch(
      `https://sponsor.ajay.app/api/skipSegments?videoID=${youtubeId}`
    );

    if (!response.ok) return;

    const segments = await response.json();

    for (const segment of segments) {
      await database.query(`
        INSERT INTO plugin_sponsorblock_segments
        (youtube_id, segment_uuid, start_time, end_time, category, action_type, votes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING
      `, [
        youtubeId,
        segment.UUID,
        segment.segment[0],
        segment.segment[1],
        segment.category,
        segment.actionType,
        segment.votes
      ]);
    }
  } catch (error) {
    peertubeHelpers.logger.error('Failed to fetch SponsorBlock segments', error);
  }
}
```

---

## Défis techniques

### 1. Identification des vidéos

**Problème** : PeerTube ne stocke pas nativement l'URL/ID YouTube source.

**Solutions** :
- ✅ Feature requests ouvertes (#2467, #6013) mais non implémentées
- ✅ Le plugin peut créer sa propre table de mapping
- ✅ Extraction de l'ID lors de l'import via hooks

### 2. Vidéos déjà importées

**Problème** : Les vidéos importées avant l'installation du plugin n'auront pas de mapping.

**Solutions** :
- Script de migration pour analyser les descriptions/métadonnées
- Interface d'administration pour lier manuellement les vidéos
- Utilisation de l'API YouTube pour rechercher par titre/description

### 3. Synchronisation avec SponsorBlock

**Problème** : Les segments SponsorBlock évoluent (nouveaux segments, votes modifiés).

**Solutions** :
- Tâche cron pour resynchroniser périodiquement
- Webhook si l'API SponsorBlock le supporte
- Cache avec TTL (Time To Live)

### 4. Modifications du schéma core

**Problème** : Modifier les tables core de PeerTube peut causer des conflits avec les migrations officielles.

**Solution** :
- ✅ Utiliser uniquement des tables personnalisées avec préfixe `plugin_*`
- ✅ Foreign keys avec `ON DELETE CASCADE` pour la cohérence

---

## Approches possibles

### Approche 1 : Skip côté client (lecteur vidéo)

**Description** : Comme SponsorBlock sur YouTube, sauter automatiquement les segments lors de la lecture.

**Implémentation** :
```javascript
registerHook({
  target: 'action:video-watch.video.loaded',
  handler: async ({ video, player }) => {
    // Récupérer l'ID YouTube
    const [rows] = await database.query(`
      SELECT youtube_id FROM plugin_sponsorblock_mapping
      WHERE peertube_uuid = $1
    `, [video.uuid]);

    if (!rows[0]) return;

    // Récupérer les segments
    const [segments] = await database.query(`
      SELECT start_time, end_time, category
      FROM plugin_sponsorblock_segments
      WHERE youtube_id = $1
    `, [rows[0].youtube_id]);

    // Implémenter le skip automatique
    player.on('timeupdate', () => {
      const currentTime = player.currentTime();

      for (const segment of segments) {
        if (currentTime >= segment.start_time &&
            currentTime < segment.end_time) {
          player.currentTime(segment.end_time);

          // Afficher une notification
          showNotification(`Segment ${segment.category} sauté`);
          break;
        }
      }
    });
  }
});
```

**Avantages** :
- ✅ Pas de modification des fichiers vidéo
- ✅ Réversible (peut être désactivé)
- ✅ Rapide à implémenter
- ✅ Pas de stockage supplémentaire

**Inconvénients** :
- ❌ Les segments sont toujours téléchargés (bande passante)
- ❌ Ne fonctionne que dans le lecteur web PeerTube
- ❌ Peut être contourné en téléchargeant la vidéo

---

### Approche 2 : Suppression permanente des segments (post-traitement vidéo)

**Description** : Modifier le fichier vidéo source pour supprimer physiquement les segments sponsorisés.

**Implémentation** :

#### Étape 1 : Hook après import

```javascript
registerHook({
  target: 'filter:api.video.post-import-url.accept.result',
  handler: async (result, params) => {
    const { videoImport } = params;
    const youtubeId = extractYouTubeId(videoImport.targetUrl);

    if (youtubeId && videoImport.video) {
      // Sauvegarder le mapping
      await saveMapping(videoImport.video.uuid, youtubeId);

      // Récupérer les segments
      const segments = await fetchSponsorBlockSegments(youtubeId);

      if (segments.length > 0) {
        // Déclencher le traitement vidéo en arrière-plan
        await queueVideoProcessing(videoImport.video.uuid, segments);
      }
    }

    return result;
  }
});
```

#### Étape 2 : Traitement vidéo avec FFmpeg

```javascript
async function processVideoRemoveSegments(videoUuid, segments) {
  const video = await peertubeHelpers.videos.loadByUrl(videoUuid);
  const videoPath = getVideoFilePath(video);
  const outputPath = getTempPath();

  // Trier les segments par ordre chronologique
  segments.sort((a, b) => a.start_time - b.start_time);

  // Créer un fichier de découpe FFmpeg
  const filterComplex = buildFFmpegFilterComplex(segments, video.duration);

  // Exécuter FFmpeg
  await execFFmpeg([
    '-i', videoPath,
    '-filter_complex', filterComplex,
    '-c:v', 'copy',  // Copier sans ré-encoder si possible
    '-c:a', 'copy',
    outputPath
  ]);

  // Remplacer le fichier original
  await replaceVideoFile(video, outputPath);

  // Mettre à jour la durée de la vidéo
  await updateVideoDuration(video);
}
```

#### Étape 3 : Construction du filtre FFmpeg

```javascript
function buildFFmpegFilterComplex(segments, duration) {
  // Créer une liste des parties à garder (inverser les segments à supprimer)
  const keepSegments = [];
  let lastEnd = 0;

  for (const segment of segments) {
    if (segment.start_time > lastEnd) {
      keepSegments.push({
        start: lastEnd,
        end: segment.start_time
      });
    }
    lastEnd = segment.end_time;
  }

  // Ajouter la dernière partie
  if (lastEnd < duration) {
    keepSegments.push({
      start: lastEnd,
      end: duration
    });
  }

  // Construire le filtre de concaténation FFmpeg
  const filters = [];

  for (let i = 0; i < keepSegments.length; i++) {
    const seg = keepSegments[i];
    filters.push(
      `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${i}]`,
      `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${i}]`
    );
  }

  // Concaténer tous les segments
  const vInputs = keepSegments.map((_, i) => `[v${i}]`).join('');
  const aInputs = keepSegments.map((_, i) => `[a${i}]`).join('');

  filters.push(
    `${vInputs}concat=n=${keepSegments.length}:v=1:a=0[outv]`,
    `${aInputs}concat=n=${keepSegments.length}:v=0:a=1[outa]`
  );

  return filters.join(';');
}
```

#### Étape 4 : Gestion de la file d'attente

```javascript
// Table pour suivre les traitements
CREATE TABLE IF NOT EXISTS plugin_sponsorblock_processing_queue (
  id SERIAL PRIMARY KEY,
  video_uuid UUID NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',  -- pending, processing, completed, failed
  segments JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  error TEXT
);

// Worker de traitement
async function processQueue() {
  const [job] = await database.query(`
    UPDATE plugin_sponsorblock_processing_queue
    SET status = 'processing', started_at = NOW()
    WHERE id = (
      SELECT id FROM plugin_sponsorblock_processing_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  if (!job[0]) return;

  try {
    await processVideoRemoveSegments(job[0].video_uuid, job[0].segments);

    await database.query(`
      UPDATE plugin_sponsorblock_processing_queue
      SET status = 'completed', completed_at = NOW()
      WHERE id = $1
    `, [job[0].id]);
  } catch (error) {
    await database.query(`
      UPDATE plugin_sponsorblock_processing_queue
      SET status = 'failed', error = $1
      WHERE id = $2
    `, [error.message, job[0].id]);
  }
}
```

**Avantages** :
- ✅ Économie de bande passante (segments supprimés)
- ✅ Économie de stockage
- ✅ Fonctionne partout (téléchargement, lecteurs externes)
- ✅ Expérience utilisateur optimale

**Inconvénients** :
- ❌ Complexe à implémenter
- ❌ Irréversible (sauf backup)
- ❌ Charge CPU/temps de traitement (FFmpeg)
- ❌ Risque de perte de qualité si ré-encodage nécessaire
- ❌ Nécessite accès aux fichiers vidéo sur le système de fichiers
- ❌ Peut nécessiter des permissions élevées

**Défis spécifiques** :

1. **Accès aux fichiers vidéo** : Les plugins ont-ils accès au système de fichiers ?
2. **Transcodage** : PeerTube stocke plusieurs versions (résolutions différentes) - il faut toutes les traiter
3. **Synchronisation** : Gérer les états pendant le traitement (vidéo temporairement indisponible ?)
4. **Atomicité** : Assurer que le remplacement du fichier est atomique
5. **Rollback** : Que faire en cas d'erreur ?

---

### Approche 3 : Hybride

**Description** : Combiner les deux approches.

**Implémentation** :
1. **Skip immédiat** : Utiliser l'approche 1 pour une expérience utilisateur immédiate
2. **Traitement en arrière-plan** : Lancer l'approche 2 en arrière-plan
3. **Mise à jour progressive** : Une fois le traitement terminé, servir la version nettoyée

**Avantages** :
- ✅ Meilleure UX (pas d'attente)
- ✅ Bénéfices des deux approches à terme

**Inconvénients** :
- ❌ Complexité maximale
- ❌ Gestion de deux systèmes parallèles

---

## Recommandations

### Phase 1 : MVP (Minimum Viable Product)

**Objectif** : Valider la faisabilité technique avec l'approche 1 (skip côté client).

**Tâches** :
1. ✅ Créer la structure du plugin
2. ✅ Implémenter la table de mapping YouTube ID
3. ✅ Hook d'import pour capturer l'ID YouTube
4. ✅ Récupération et cache des segments SponsorBlock
5. ✅ Skip automatique dans le lecteur vidéo
6. ✅ Interface de configuration (activer/désactiver par catégorie)

**Durée estimée** : Non applicable (pas d'estimations de temps)

### Phase 2 : Amélioration

**Objectif** : Ajouter des fonctionnalités avancées.

**Tâches** :
- Interface d'administration pour gérer les mappings
- Synchronisation périodique avec SponsorBlock
- Support des vidéos déjà importées (migration)
- Statistiques (segments sautés, temps économisé)
- Indicateurs visuels sur la timeline

### Phase 3 : Suppression permanente (optionnel)

**Objectif** : Implémenter l'approche 2 si nécessaire.

**Pré-requis** :
- Vérifier les permissions d'accès aux fichiers
- Tester la performance FFmpeg
- Implémenter un système de backup
- Gérer les états de traitement

**À explorer** :
- PeerTube a-t-il une API pour le transcodage ?
- Peut-on réutiliser le système de jobs existant ?
- Comment gérer les WebTorrents (fichiers distribués) ?

---

## Ressources

### Documentation PeerTube

- **Guide des plugins** : https://docs.joinpeertube.org/contribute/plugins
- **API Plugins** : https://docs.joinpeertube.org/api/plugins
- **API Embed** : https://docs.joinpeertube.org/api/embed-player
- **Guide de développement serveur** : https://docs.joinpeertube.org/support/doc/development/server
- **Architecture** : https://docs.joinpeertube.org/contribute/architecture

### Exemples de plugins

- **peertube-plugin-chapters** : https://github.com/samlich/peertube-plugin-chapters
- **Liste des plugins** : https://framagit.org/framasoft/peertube/official-plugins

### API SponsorBlock

- **Documentation API** : https://wiki.sponsor.ajay.app/w/API_Docs
- **Code source** : https://github.com/ajayyy/SponsorBlock
- **Endpoint principal** : `GET https://sponsor.ajay.app/api/skipSegments?videoID={videoID}`

### Outils

- **FFmpeg** : https://ffmpeg.org/documentation.html
- **Sequelize (ORM PeerTube)** : https://sequelize.org/docs/v6/

### Issues GitHub pertinentes

- [#2467 - Stocker l'URL originale des imports](https://github.com/Chocobozzz/PeerTube/issues/2467)
- [#6013 - Stocker l'URL d'import](https://github.com/Chocobozzz/PeerTube/issues/6013)
- [#1209 - SponsorBlock: Add PeerTube support](https://github.com/ajayyy/SponsorBlock/issues/1209)
- [#1938 - Lack of PeerTube Support](https://github.com/ajayyy/SponsorBlock/issues/1938)

---

## Prochaines étapes

1. **Analyser le code source de peertube-plugin-chapters** pour comprendre la structure
2. **Créer le squelette du plugin** avec package.json et structure de base
3. **Tester les hooks** dans un environnement de développement PeerTube
4. **Implémenter le MVP** (approche 1 : skip côté client)
5. **Tester** sur une instance PeerTube de développement
6. **Publier** sur NPM et le registry PeerTube

---

## Notes

- **Permissions** : À vérifier si les plugins peuvent accéder aux fichiers vidéo pour l'approche 2
- **Performance** : FFmpeg peut être très consommateur de ressources
- **Stockage** : L'approche 2 nécessite un espace temporaire pour le traitement
- **Licence** : SponsorBlock est LGPL 3.0, vérifier la compatibilité
