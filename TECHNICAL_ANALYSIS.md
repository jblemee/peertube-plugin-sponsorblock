# Analyse technique : Suppression permanente des segments sponsors

**Date** : 2026-01-31
**Objectif** : Analyser la faisabilité de modifier les fichiers vidéo à la source pour supprimer définitivement les segments sponsorisés détectés par SponsorBlock.

---

## Table des matières

1. [Architecture de stockage PeerTube](#architecture-de-stockage-peertube)
2. [Système de transcodage](#système-de-transcodage)
3. [Approche de suppression des segments](#approche-de-suppression-des-segments)
4. [Implémentation FFmpeg](#implémentation-ffmpeg)
5. [Gestion des jobs](#gestion-des-jobs)
6. [Défis et risques](#défis-et-risques)
7. [Recommandations](#recommandations)

---

## Architecture de stockage PeerTube

### Structure des répertoires

PeerTube stocke les vidéos dans `/var/www/peertube/storage/` avec plusieurs sous-dossiers :

```
/var/www/peertube/storage/
├── tmp/                        # Téléchargements temporaires, uploads en cours
├── tmp_persistent/             # Tmp persistant entre redémarrages
├── original-video-files/       # Fichiers vidéo originaux uploadés
├── web-videos/                 # Vidéos web (différentes résolutions)
├── streaming-playlists/        # Playlists HLS pour streaming adaptatif
│   └── hls/                    # Segments HLS
├── redundancy/                 # Copies de redondance
├── previews/                   # Miniatures vidéo
├── avatars/                    # Avatars utilisateurs
└── logs/                       # Logs
```

**Source** : [An Admin's Guide to Fixing PeerTube](https://wedistribute.org/2024/07/fixing-peertube-videos/)

### Types de fichiers vidéo

Pour chaque vidéo uploadée, PeerTube génère plusieurs versions :

1. **Fichier original** (`original-video-files/`)
   - Fichier tel qu'uploadé par l'utilisateur
   - Conservé pour archives ou re-transcodage ultérieur

2. **Vidéos web** (`web-videos/`)
   - Versions transcodées en plusieurs résolutions (240p, 360p, 480p, 720p, 1080p, etc.)
   - Format optimisé pour le streaming P2P WebTorrent

3. **Playlists HLS** (`streaming-playlists/hls/`)
   - Segments vidéo pour streaming adaptatif
   - Fichiers `.m3u8` (playlists) + segments `.ts` ou `.m4s`

### Support du stockage objet

PeerTube peut utiliser S3/MinIO pour le stockage distant :
- `web_videos` prefix
- `streaming_playlists` prefix
- `original_video_files` prefix

**Implication** : Le plugin doit gérer à la fois le stockage local et distant.

**Source** : [Remote storage (S3)](https://docs.joinpeertube.org/maintain/remote-storage)

---

## Système de transcodage

### Architecture des jobs

PeerTube utilise **Bull** (basé sur Redis) pour gérer la file d'attente des jobs :

```
Utilisateur upload → Import job → Transcodage jobs → Vidéo disponible
                                    ├─ Résolution 1 (480p)
                                    ├─ Résolution 2 (720p)
                                    └─ Résolution 3 (1080p)
```

**Flux de traitement** :
1. Upload/import de la vidéo → stockage dans `original-video-files/`
2. Job de transcodage créé dans la queue Redis
3. Worker FFmpeg traite la vidéo
4. Génération des résolutions dans `web-videos/` et/ou `streaming-playlists/`
5. Mise à jour de la base de données avec les métadonnées

**Source** : [Architecture | PeerTube documentation](https://docs.joinpeertube.org/contribute/architecture)

### API de transcodage pour plugins

Depuis PeerTube 3.1, les plugins peuvent modifier le transcodage via `transcodingManager` :

```javascript
async function register ({ transcodingManager }) {

  // Enregistrer un profil de transcodage personnalisé
  const builder = (options) => {
    return {
      inputOptions: [],
      outputOptions: [
        '-vcodec libx264',
        '-acodec aac'
      ]
    };
  };

  const encoder = 'custom-encoder';
  const priority = 100;

  transcodingManager.addVODProfile(encoder, priority, builder);
  transcodingManager.addVODEncoderPriority('video', encoder, priority);
}
```

**Limitations** :
- Modifie le **profil de transcodage** (paramètres FFmpeg)
- Ne permet pas d'injecter du code **avant** ou **après** le transcodage
- Pas de hook pour intercepter/modifier les jobs existants

**Source** : [PeerTube 3.1 Is Released](https://linuxreviews.org/PeerTube_3.1_Is_Released_With_Advanced_Transcoding_Options_And_A_More_Polished_User-Interface)

### Remote transcoding runners

PeerTube supporte le transcodage distant :
- Runners qui se connectent via HTTP/WebSocket
- Jobs stockés en DB et assignés aux runners
- Permet de décharger le serveur principal

**Implication** : Si l'instance utilise des runners distants, le plugin doit pouvoir y accéder ou fonctionner après le transcodage.

**Source** : [Support for transcoding by remote workers](https://github.com/Chocobozzz/PeerTube/issues/947)

---

## Approche de suppression des segments

### Option 1 : Modification post-import (avant transcodage)

**Moment** : Juste après l'import, avant le transcodage.

**Workflow** :
```
Import YouTube → Récupérer segments SponsorBlock → Modifier fichier original → Lancer transcodage
```

**Avantages** :
- ✅ Une seule modification du fichier original
- ✅ Toutes les résolutions générées seront déjà nettoyées
- ✅ Économie de bande passante et stockage maximale

**Inconvénients** :
- ❌ Doit intercepter **avant** le transcodage (hook disponible ?)
- ❌ Retarde la disponibilité de la vidéo
- ❌ Complexe à synchroniser avec le système de jobs

**Hook potentiel** :
```javascript
registerHook({
  target: 'filter:api.video.post-import-url.accept.result',
  handler: async (result, params) => {
    const { videoImport } = params;

    // 1. Récupérer segments SponsorBlock
    // 2. Modifier le fichier original
    // 3. Laisser le transcodage se faire normalement

    return result;
  }
});
```

### Option 2 : Modification post-transcodage

**Moment** : Après le transcodage, modifier toutes les versions générées.

**Workflow** :
```
Import → Transcodage → Vidéo disponible → Récupérer segments → Re-traiter tous les fichiers
```

**Avantages** :
- ✅ Vidéo disponible rapidement (pas de blocage)
- ✅ Peut fonctionner sur vidéos existantes
- ✅ Plus facile à implémenter (async)

**Inconvénients** :
- ❌ Doit traiter **toutes** les résolutions (480p, 720p, 1080p, etc.)
- ❌ Consommation CPU importante (re-transcodage partiel)
- ❌ Double stockage temporaire

**Hook potentiel** :
```javascript
registerHook({
  target: 'action:api.video.updated',
  handler: async ({ video }) => {
    // Vérifier si le transcodage est terminé
    if (video.state === VideoState.PUBLISHED) {
      // Lancer le traitement de suppression des segments
      await queueSegmentRemovalJob(video);
    }
  }
});
```

### Option 3 : Job de transcodage personnalisé

**Moment** : Remplacer/compléter les jobs de transcodage standards.

**Workflow** :
```
Import → Job de nettoyage SponsorBlock → Job de transcodage standard → Vidéo disponible
```

**Avantages** :
- ✅ Intégration native dans le pipeline de transcodage
- ✅ Pas de re-traitement
- ✅ Économie de ressources

**Inconvénients** :
- ❌ Nécessite accès aux internals de PeerTube (job queue)
- ❌ Risque de breaking changes lors des mises à jour
- ❌ Complexité élevée

**Faisabilité** : À explorer - les plugins peuvent-ils créer des jobs personnalisés ?

---

## Implémentation FFmpeg

### Découpe et concaténation de segments

Pour supprimer les segments sponsors, on doit :
1. Découper la vidéo en segments (parties à garder)
2. Concaténer ces segments

#### Méthode 1 : Filter complex (sans ré-encodage si possible)

```bash
ffmpeg -i input.mp4 \
  -filter_complex "\
    [0:v]trim=start=0:end=30,setpts=PTS-STARTPTS[v0]; \
    [0:a]atrim=start=0:end=30,asetpts=PTS-STARTPTS[a0]; \
    [0:v]trim=start=60:end=120,setpts=PTS-STARTPTS[v1]; \
    [0:a]atrim=start=60:end=120,asetpts=PTS-STARTPTS[a1]; \
    [v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]" \
  -map "[outv]" -map "[outa]" \
  -c:v libx264 -c:a aac \
  output.mp4
```

**Avantages** :
- Un seul passage FFmpeg
- Synchronisation audio/vidéo préservée

**Inconvénients** :
- ⚠️ **Ré-encodage obligatoire** (perte de qualité, temps CPU)
- Les filtres `trim` et `concat` ne supportent pas la copie de stream

#### Méthode 2 : Découpe + concaténation avec copy codec (sans ré-encodage)

**Étape 1** : Découper les segments à garder
```bash
# Segment 1 : 0s - 30s
ffmpeg -i input.mp4 -ss 0 -to 30 -c copy segment1.mp4

# Segment 2 : 60s - 120s (après un sponsor de 30s-60s)
ffmpeg -i input.mp4 -ss 60 -to 120 -c copy segment2.mp4
```

**Étape 2** : Créer un fichier de concaténation
```
# concat.txt
file 'segment1.mp4'
file 'segment2.mp4'
```

**Étape 3** : Concaténer
```bash
ffmpeg -f concat -safe 0 -i concat.txt -c copy output.mp4
```

**Avantages** :
- ✅ Pas de ré-encodage (très rapide)
- ✅ Pas de perte de qualité
- ✅ Consommation CPU minimale

**Inconvénients** :
- ❌ Nécessite des coupures aux **keyframes** exactes
- ❌ Peut avoir des problèmes de synchronisation A/V si les coupures ne sont pas précises
- ❌ Fichiers temporaires (segments)

**Solution hybrid** : Couper aux keyframes proches + ré-encoder seulement les transitions

#### Méthode 3 : Re-multiplexing avec segment removal (expérimental)

Utiliser `ffmpeg` avec `select` filter pour les frames :

```bash
ffmpeg -i input.mp4 \
  -vf "select='not(between(t,30,60))',setpts=N/FRAME_RATE/TB" \
  -af "aselect='not(between(t,30,60))',asetpts=N/SR/TB" \
  -c:v libx264 -c:a aac \
  output.mp4
```

**Avantages** :
- Un seul passage
- Précision frame par frame

**Inconvénients** :
- ⚠️ **Ré-encodage obligatoire**
- Complexe à générer pour multiples segments

### Code de génération du filtre FFmpeg

```javascript
/**
 * Construit une commande FFmpeg pour supprimer des segments d'une vidéo
 * @param {string} inputPath - Chemin du fichier d'entrée
 * @param {Array} segments - Segments à supprimer [{start: 30, end: 60}, ...]
 * @param {number} duration - Durée totale de la vidéo en secondes
 * @param {string} outputPath - Chemin du fichier de sortie
 * @returns {Array} Arguments FFmpeg
 */
function buildFFmpegRemovalCommand(inputPath, segments, duration, outputPath) {
  // Tri des segments par ordre chronologique
  const sortedSegments = segments
    .sort((a, b) => a.start - b.start);

  // Calculer les segments à GARDER (inversion)
  const keepSegments = [];
  let lastEnd = 0;

  for (const segment of sortedSegments) {
    if (segment.start > lastEnd) {
      keepSegments.push({
        start: lastEnd,
        end: segment.start
      });
    }
    lastEnd = Math.max(lastEnd, segment.end);
  }

  // Ajouter le dernier segment jusqu'à la fin
  if (lastEnd < duration) {
    keepSegments.push({
      start: lastEnd,
      end: duration
    });
  }

  // Si aucun segment à garder, erreur
  if (keepSegments.length === 0) {
    throw new Error('No segments to keep - video would be empty');
  }

  // Méthode 1 : Découpe + concat (sans ré-encodage)
  return buildSegmentedApproach(inputPath, keepSegments, outputPath);
}

/**
 * Approche découpe + concaténation (sans ré-encodage)
 */
function buildSegmentedApproach(inputPath, keepSegments, outputPath) {
  const segmentFiles = [];
  const commands = [];

  // Étape 1 : Découper chaque segment
  keepSegments.forEach((seg, index) => {
    const segmentPath = `/tmp/segment_${index}.mp4`;
    segmentFiles.push(segmentPath);

    commands.push({
      args: [
        '-i', inputPath,
        '-ss', seg.start.toString(),
        '-to', seg.end.toString(),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        segmentPath
      ],
      description: `Extract segment ${index}: ${seg.start}s - ${seg.end}s`
    });
  });

  // Étape 2 : Créer le fichier concat
  const concatFilePath = '/tmp/concat_list.txt';
  const concatContent = segmentFiles
    .map(f => `file '${f}'`)
    .join('\n');

  // Étape 3 : Concaténer
  commands.push({
    args: [
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFilePath,
      '-c', 'copy',
      outputPath
    ],
    description: 'Concatenate segments',
    concatFile: {
      path: concatFilePath,
      content: concatContent
    },
    cleanup: segmentFiles
  });

  return commands;
}

/**
 * Approche filter complex (avec ré-encodage)
 * À utiliser si la méthode sans ré-encodage échoue
 */
function buildFilterComplexApproach(inputPath, keepSegments, outputPath) {
  const filters = [];

  // Créer les filtres trim pour chaque segment
  keepSegments.forEach((seg, index) => {
    filters.push(
      `[0:v]trim=start=${seg.start}:end=${seg.end},setpts=PTS-STARTPTS[v${index}]`,
      `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[a${index}]`
    );
  });

  // Construire la concaténation
  const vInputs = keepSegments.map((_, i) => `[v${i}]`).join('');
  const aInputs = keepSegments.map((_, i) => `[a${i}]`).join('');

  filters.push(
    `${vInputs}concat=n=${keepSegments.length}:v=1:a=0[outv]`,
    `${aInputs}concat=n=${keepSegments.length}:v=0:a=1[outa]`
  );

  const filterComplex = filters.join(';');

  return [{
    args: [
      '-i', inputPath,
      '-filter_complex', filterComplex,
      '-map', '[outv]',
      '-map', '[outa]',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      outputPath
    ],
    description: 'Process with filter_complex (re-encoding)'
  }];
}
```

### Gestion des multiples résolutions

Chaque vidéo a plusieurs fichiers (résolutions différentes). Il faut **tous** les traiter :

```javascript
async function processAllVideoFiles(videoUuid, segments) {
  const video = await peertubeHelpers.videos.loadByUrl(videoUuid);

  // Récupérer tous les fichiers vidéo
  const videoFiles = await getVideoFiles(video);

  // Traiter chaque résolution
  for (const file of videoFiles) {
    const inputPath = file.path;
    const outputPath = `${inputPath}.processed`;

    // Générer la commande FFmpeg
    const commands = buildFFmpegRemovalCommand(
      inputPath,
      segments,
      video.duration,
      outputPath
    );

    // Exécuter FFmpeg
    await executeFFmpegCommands(commands);

    // Remplacer le fichier original
    await replaceFile(inputPath, outputPath);
  }

  // Mettre à jour la durée de la vidéo
  const newDuration = calculateNewDuration(video.duration, segments);
  await updateVideoDuration(video, newDuration);
}
```

### Gestion des playlists HLS

Les playlists HLS sont composées de **multiples segments** `.ts` ou `.m4s` :

```
playlist.m3u8
segment-0.ts
segment-1.ts
segment-2.ts
...
```

**Problème** : Supprimer des segments sponsors dans une playlist HLS est **très complexe** :
- Les segments ont des durées fixes (ex: 2s, 4s, 6s)
- Il faut recalculer les timestamps de tous les segments
- Modifier le fichier `.m3u8`

**Solution recommandée** :
1. **Option A** : Ne traiter que les `web-videos` (pas HLS)
2. **Option B** : Forcer un re-transcodage complet en HLS après modification
3. **Option C** : Désactiver HLS pour les vidéos traitées

---

## Gestion des jobs

### Architecture de file d'attente

```javascript
// Table pour suivre les jobs de traitement
CREATE TABLE IF NOT EXISTS plugin_sponsorblock_processing_queue (
  id SERIAL PRIMARY KEY,
  video_uuid UUID NOT NULL REFERENCES video(uuid) ON DELETE CASCADE,
  youtube_id VARCHAR(11) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  -- pending, processing, completed, failed, cancelled
  priority INTEGER DEFAULT 0,
  segments JSONB NOT NULL,
  error TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE INDEX idx_queue_status ON plugin_sponsorblock_processing_queue(status, priority, created_at);
```

### Worker de traitement

```javascript
let isProcessing = false;

async function startWorker(peertubeHelpers) {
  if (isProcessing) return;

  const interval = setInterval(async () => {
    try {
      await processNextJob(peertubeHelpers);
    } catch (error) {
      peertubeHelpers.logger.error('Worker error', error);
    }
  }, 5000); // Toutes les 5 secondes

  // Cleanup au unload du plugin
  peertubeHelpers.onUnload(() => {
    clearInterval(interval);
  });
}

async function processNextJob(peertubeHelpers) {
  const database = peertubeHelpers.database;

  // Verrouillage optimiste avec FOR UPDATE SKIP LOCKED
  const [jobs] = await database.query(`
    UPDATE plugin_sponsorblock_processing_queue
    SET status = 'processing', started_at = NOW()
    WHERE id = (
      SELECT id FROM plugin_sponsorblock_processing_queue
      WHERE status = 'pending'
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  if (!jobs || jobs.length === 0) {
    return; // Aucun job en attente
  }

  const job = jobs[0];
  isProcessing = true;

  try {
    // Traiter la vidéo
    await processVideoRemoveSegments(
      job.video_uuid,
      job.segments,
      peertubeHelpers
    );

    // Marquer comme terminé
    await database.query(`
      UPDATE plugin_sponsorblock_processing_queue
      SET status = 'completed', completed_at = NOW()
      WHERE id = $1
    `, [job.id]);

    peertubeHelpers.logger.info(
      `Successfully processed video ${job.video_uuid}`
    );

  } catch (error) {
    peertubeHelpers.logger.error(
      `Failed to process video ${job.video_uuid}`,
      error
    );

    // Retry logic
    const shouldRetry = job.retry_count < job.max_retries;

    if (shouldRetry) {
      await database.query(`
        UPDATE plugin_sponsorblock_processing_queue
        SET status = 'pending',
            retry_count = retry_count + 1,
            error = $1
        WHERE id = $2
      `, [error.message, job.id]);
    } else {
      await database.query(`
        UPDATE plugin_sponsorblock_processing_queue
        SET status = 'failed',
            completed_at = NOW(),
            error = $1
        WHERE id = $2
      `, [error.message, job.id]);
    }
  } finally {
    isProcessing = false;
  }
}
```

### Priorisation des jobs

- **Priorité haute** : Vidéos récentes (< 24h)
- **Priorité normale** : Vidéos anciennes
- **Priorité basse** : Re-traitement (mise à jour des segments)

```javascript
async function queueVideoProcessing(videoUuid, youtubeId, segments, priority = 0) {
  await database.query(`
    INSERT INTO plugin_sponsorblock_processing_queue
    (video_uuid, youtube_id, segments, priority)
    VALUES ($1, $2, $3, $4)
  `, [videoUuid, youtubeId, JSON.stringify(segments), priority]);
}
```

---

## Défis et risques

### 1. Accès au système de fichiers

**Problème** : Les plugins ont-ils un accès direct aux fichiers vidéo ?

**Recherche nécessaire** :
- Tester si `peertubeHelpers` expose les chemins de fichiers
- Vérifier les permissions (le processus du plugin peut-il lire/écrire ?)
- Voir si PeerTube sandbox les plugins

**Workaround potentiel** :
- Utiliser l'API interne de PeerTube pour charger les vidéos
- Forcer un re-transcodage via l'API plutôt qu'un traitement direct

### 2. Atomicité et cohérence

**Problème** : Que se passe-t-il si le traitement échoue à mi-chemin ?

**Risques** :
- Fichier vidéo corrompu
- Vidéo partiellement traitée (certaines résolutions oui, d'autres non)
- Métadonnées incohérentes (durée incorrecte)

**Solutions** :
- ✅ Traiter dans un fichier temporaire, swap atomique à la fin
- ✅ Transaction sur les métadonnées DB
- ✅ Backup automatique du fichier original
- ✅ Rollback en cas d'erreur

```javascript
async function processVideoSafe(videoPath, segments) {
  const backupPath = `${videoPath}.backup`;
  const tempPath = `${videoPath}.tmp`;

  try {
    // 1. Backup
    await fs.copyFile(videoPath, backupPath);

    // 2. Traitement
    await processVideo(videoPath, segments, tempPath);

    // 3. Vérification
    const isValid = await verifyVideoIntegrity(tempPath);
    if (!isValid) {
      throw new Error('Processed video is corrupted');
    }

    // 4. Swap atomique
    await fs.rename(tempPath, videoPath);

    // 5. Supprimer le backup (optionnel)
    await fs.unlink(backupPath);

  } catch (error) {
    // Rollback
    if (await fs.exists(backupPath)) {
      await fs.copyFile(backupPath, videoPath);
    }
    throw error;
  }
}
```

### 3. Performance et charge système

**Problème** : FFmpeg consomme beaucoup de CPU/mémoire.

**Impacts** :
- Ralentissement du serveur
- File d'attente qui s'accumule
- Timeout des jobs

**Solutions** :
- ✅ Limiter le nombre de jobs concurrents (ex: 1 seul à la fois)
- ✅ Nice/ionice pour baisser la priorité
- ✅ Traitement pendant les heures creuses
- ✅ Option pour désactiver le traitement automatique

```javascript
// Configuration du plugin
{
  "enable_auto_processing": true,
  "max_concurrent_jobs": 1,
  "processing_hours": "02:00-06:00", // Heures creuses
  "cpu_priority": "low" // nice level
}
```

### 4. Perte de qualité

**Problème** : Le ré-encodage peut dégrader la qualité.

**Solutions** :
- ✅ Préférer `-c copy` (sans ré-encodage)
- ✅ Si ré-encodage nécessaire, utiliser CRF élevé (18-23)
- ✅ Conserver le fichier original en backup

**Comparaison** :
- **Sans ré-encodage** : Rapide, sans perte, mais coupures aux keyframes uniquement
- **Avec ré-encodage** : Précis, mais lent et perte de qualité potentielle

### 5. Stockage distant (S3)

**Problème** : Les fichiers peuvent être sur S3/MinIO, pas en local.

**Solutions** :
- ✅ Télécharger temporairement en local
- ✅ Traiter
- ✅ Re-upload vers S3
- ❌ Consommation de bande passante importante

**Alternative** : Ne supporter que le stockage local (limitation documentée).

### 6. Synchronisation des métadonnées

**Problème** : Durée de la vidéo, seeking, thumbnails.

**Impacts** :
- La durée affichée ne correspond plus
- Les miniatures peuvent pointer vers des moments supprimés
- Les timestamps de commentaires sont décalés

**Solutions** :
- ✅ Recalculer la durée totale
- ✅ Régénérer les thumbnails
- ⚠️ Impossible de corriger les timestamps de commentaires existants

### 7. Contenu décalé

**Problème** : Si un utilisateur commente "à 5:23", mais qu'on a supprimé 2min avant, le timestamp est faux.

**Solution** : Documenter cette limitation - c'est un trade-off accepté.

---

## Recommandations

### Approche recommandée

**Phase 1** : Implémenter l'approche **skip côté client** (RESEARCH.md - Approche 1)
- Rapide à développer
- Sans risque
- Valide le concept

**Phase 2** : Ajouter la suppression permanente **optionnelle**
- Option dans les paramètres du plugin
- Par défaut : désactivée
- Warning clair sur les risques

**Phase 3** : Affiner selon les retours
- Optimisations FFmpeg
- Support du stockage distant
- Interface de monitoring

### Configuration suggérée

```json
{
  "mode": "skip",  // "skip" | "remove" | "hybrid"
  "remove_segments_on_import": false,
  "backup_original_files": true,
  "processing_priority": "low",
  "max_concurrent_jobs": 1,
  "require_confirmation": true,
  "categories_to_remove": ["sponsor", "selfpromo"],
  "minimum_segment_duration": 5,  // Ne supprimer que si > 5s
  "ffmpeg_method": "auto"  // "copy" | "reencode" | "auto"
}
```

### Tests essentiels avant production

1. **Test sur vidéo de test** : Créer une vidéo avec segments connus
2. **Test de rollback** : Simuler une erreur, vérifier la restauration
3. **Test de performance** : Mesurer CPU/mémoire/temps
4. **Test multi-résolutions** : Vérifier que toutes les versions sont cohérentes
5. **Test de lecture** : S'assurer que la vidéo se lit correctement après traitement

### Documentation utilisateur

Informer clairement les administrateurs :

```markdown
⚠️ **Mode de suppression permanente**

Ce mode modifie les fichiers vidéo originaux pour supprimer définitivement
les segments sponsorisés.

**Avantages** :
- Économie de stockage et bande passante
- Expérience optimale pour tous les clients

**Risques** :
- Modification irréversible (sauf si backup activé)
- Charge CPU importante
- Timestamps de commentaires décalés
- Peut causer des problèmes en cas d'erreur

**Recommandations** :
- Activez les backups automatiques
- Testez d'abord sur quelques vidéos
- Surveillez les logs et la charge système
- Ayez un plan de restauration

Pour la plupart des usages, le mode "skip" (saut côté client) est suffisant.
```

---

## Ressources complémentaires

### Documentation PeerTube

- [Architecture | PeerTube](https://docs.joinpeertube.org/contribute/architecture)
- [CLI tools guide](https://docs.joinpeertube.org/maintain/tools)
- [Configuration](https://docs.joinpeertube.org/admin/configuration)
- [Remote storage (S3)](https://docs.joinpeertube.org/maintain/remote-storage)

### FFmpeg

- [FFmpeg trim filter](https://ffmpeg.org/ffmpeg-filters.html#trim)
- [FFmpeg concat demuxer](https://ffmpeg.org/ffmpeg-formats.html#concat-1)
- [FFmpeg concat filter](https://ffmpeg.org/ffmpeg-filters.html#concat)

### Articles

- [An Admin's Guide to Fixing PeerTube](https://wedistribute.org/2024/07/fixing-peertube-videos/)
- [PeerTube 3.1 Release](https://linuxreviews.org/PeerTube_3.1_Is_Released_With_Advanced_Transcoding_Options_And_A_More_Polished_User-Interface)

---

## Conclusion

La suppression permanente des segments sponsors est **techniquement faisable** mais présente des **défis significatifs** :

✅ **Faisable** :
- Accès à la base de données
- Exécution de FFmpeg
- Gestion de jobs async
- Hooks pour intercepter les imports

❌ **Challenges** :
- Accès aux fichiers (à confirmer)
- Performance (charge CPU)
- Risques de corruption
- Gestion du stockage distant

🎯 **Recommandation** : Commencer par l'approche skip (côté client), puis ajouter la suppression permanente comme fonctionnalité **optionnelle et avancée** avec warnings appropriés.
