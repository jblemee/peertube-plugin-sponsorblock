# Bug Report: peertube-plugin-sponsorblock sur PeerTube v8

## Environnement de test

| Composant | Version |
|-----------|---------|
| PeerTube | 8.0.2 (Docker `chocobozzz/peertube:production`) |
| Sequelize | 6.37.7 |
| PostgreSQL | 17 |
| Navigateur | Firefox 147 |
| Node.js | (celui embarqué dans l'image PeerTube v8) |

Instance : `video.ut0pia.org`
221 vidéos importées depuis YouTube, dont 20 avec des segments SponsorBlock (23 segments au total).

---

## Bug #1 — Toutes les requêtes SQL échouent (server-side)

### Symptôme

Aucune route API ne fonctionne. Le serveur retourne des erreurs 500 pour toutes les requêtes plugin.

### Erreur dans les logs PeerTube

```
SequelizeDatabaseError: there is no parameter $1
    at Query.formatError (/app/node_modules/sequelize/lib/dialects/postgres/query.js:386:16)
```

### Cause racine

`peertubeHelpers.database` expose l'instance **Sequelize** de PeerTube. La méthode `query()` de Sequelize attend un objet `{ bind: [...] }` comme second argument pour les bind parameters `$1, $2, ...`.

Le plugin passe un **tableau nu** au lieu de l'objet `{ bind: [...] }` :

```javascript
// ❌ Code actuel (ne fonctionne pas)
await database.query(`
  SELECT youtube_id FROM plugin_sponsorblock_mapping
  WHERE peertube_uuid = $1
`, [videoUuid])

// ✅ Correction
await database.query(`
  SELECT youtube_id FROM plugin_sponsorblock_mapping
  WHERE peertube_uuid = $1
`, { bind: [videoUuid] })
```

### Fichiers concernés et nombre d'occurrences

| Fichier | Occurrences |
|---------|-------------|
| `main.js` | 5 (`saveYouTubeMapping`, `fetchAndCacheSegments` ×3, `queueVideoProcessing` ×2) |
| `server/routes.js` | 12 (toutes les routes + `fetchAndCacheSegments` ×3) |
| **Total** | **17** |

### Référence

- [Sequelize v6 — Raw Queries — Bind Parameter](https://sequelize.org/docs/v6/core-concepts/raw-queries/#bind-parameter)
- [PeerTube Plugin API — database](https://docs.joinpeertube.org/contribute/plugins#database)

### Diff complet (server-side)

<details>
<summary>main.js — 5 corrections</summary>

```diff
--- a/main.js
+++ b/main.js
@@ -273,7 +273,7 @@ async function saveYouTubeMapping(peertubeHelpers, peertubeUuid, youtubeId) {
     VALUES ($1, $2)
     ON CONFLICT (peertube_uuid) DO UPDATE
       SET youtube_id = $2, last_sync = NOW()
-  `, [peertubeUuid, youtubeId])
+  `, { bind: [peertubeUuid, youtubeId] })
 }

@@ -304,7 +304,7 @@ async function fetchAndCacheSegments(...)
     await database.query(`
       DELETE FROM plugin_sponsorblock_segments WHERE youtube_id = $1
-    `, [youtubeId])
+    `, { bind: [youtubeId] })

@@ -313,7 +313,7 @@ async function fetchAndCacheSegments(...)
         (youtube_id, segment_uuid, start_time, end_time, category, action_type, votes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (segment_uuid) DO NOTHING
-      `, [
+      `, { bind: [
         youtubeId, segment.UUID, segment.segment[0], segment.segment[1],
         segment.category, segment.actionType || 'skip', segment.votes || 0
-      ])
+      ] })

@@ -345,7 +345,7 @@ async function queueVideoProcessing(...)
       FROM plugin_sponsorblock_segments
       WHERE youtube_id = $1
       ORDER BY start_time ASC
-    `, [youtubeId])
+    `, { bind: [youtubeId] })

@@ -357,7 +357,7 @@ async function queueVideoProcessing(...)
       INSERT INTO plugin_sponsorblock_processing_queue
       (video_uuid, youtube_id, segments, priority)
       VALUES ($1, $2, $3, 10)
-    `, [videoUuid, youtubeId, JSON.stringify(segments)])
+    `, { bind: [videoUuid, youtubeId, JSON.stringify(segments)] })
```

</details>

<details>
<summary>server/routes.js — 12 corrections</summary>

```diff
--- a/server/routes.js
+++ b/server/routes.js

 # GET /segments/:videoUuid
@@ -19,7 +19,7 @@
       SELECT youtube_id FROM plugin_sponsorblock_mapping
       WHERE peertube_uuid = $1
-    `, [videoUuid])
+    `, { bind: [videoUuid] })

@@ -42,7 +42,7 @@
       FROM plugin_sponsorblock_segments
       WHERE youtube_id = $1
       ORDER BY start_time ASC
-    `, [youtubeId])
+    `, { bind: [youtubeId] })

 # GET /mapping/:videoUuid
@@ -73,7 +73,7 @@
       SELECT youtube_id, created_at, last_sync
       FROM plugin_sponsorblock_mapping
       WHERE peertube_uuid = $1
-    `, [videoUuid])
+    `, { bind: [videoUuid] })

 # POST /mapping/:videoUuid
@@ -127,7 +127,7 @@
       INSERT INTO plugin_sponsorblock_mapping ...
       ON CONFLICT (peertube_uuid) DO UPDATE SET youtube_id = $2, last_sync = NOW()
-    `, [videoUuid, youtubeId])
+    `, { bind: [videoUuid, youtubeId] })

 # POST /scan
@@ -184,7 +184,7 @@
       SELECT 1 FROM plugin_sponsorblock_mapping WHERE peertube_uuid = $1
-    `, [row.uuid])
+    `, { bind: [row.uuid] })

@@ -193,7 +193,7 @@
       INSERT INTO plugin_sponsorblock_mapping ...
       ON CONFLICT (peertube_uuid) DO NOTHING
-    `, [row.uuid, youtubeId])
+    `, { bind: [row.uuid, youtubeId] })

 # POST /sync/:videoUuid
@@ -228,7 +228,7 @@
       SELECT youtube_id FROM plugin_sponsorblock_mapping
       WHERE peertube_uuid = $1
-    `, [videoUuid])
+    `, { bind: [videoUuid] })

@@ -253,7 +253,7 @@
       DELETE FROM plugin_sponsorblock_segments WHERE youtube_id = $1
-    `, [youtubeId])
+    `, { bind: [youtubeId] })

@@ -263,7 +263,7 @@
       INSERT INTO plugin_sponsorblock_segments ...
       ON CONFLICT (segment_uuid) DO NOTHING
-    `, [
+    `, { bind: [
       youtubeId, segment.UUID, segment.segment[0], segment.segment[1],
       segment.category, segment.actionType || 'skip', segment.votes || 0
-    ])
+    ] })

@@ -280,7 +280,7 @@
       UPDATE plugin_sponsorblock_mapping
       SET last_sync = NOW()
       WHERE peertube_uuid = $1
-    `, [videoUuid])
+    `, { bind: [videoUuid] })

 # fetchAndCacheSegments (standalone function)
@@ -351,7 +351,7 @@
     DELETE FROM plugin_sponsorblock_segments WHERE youtube_id = $1
-  `, [youtubeId])
+  `, { bind: [youtubeId] })

@@ -361,7 +361,7 @@
     INSERT INTO plugin_sponsorblock_segments ...
     ON CONFLICT (segment_uuid) DO NOTHING
-  `, [
+  `, { bind: [
     youtubeId, segment.UUID, segment.segment[0], segment.segment[1],
     segment.category, segment.actionType || 'skip', segment.votes || 0
-  ])
+  ] })
```

</details>

### Statut

**Corrigé et vérifié** : Après correction, l'API retourne correctement les segments :
```
GET /plugins/sponsorblock/router/segments/<uuid> → 200 OK
{ "videoUuid": "...", "youtubeId": "...", "segments": [...] }
```

---

## Bug #2 — Le player PeerTube v8 rejette `player.on('timeupdate', ...)` (client-side)

### Symptôme

Le script client se charge mais aucun segment n'est skippé. L'erreur suivante apparaît dans la console du navigateur :

```
[SponsorBlock] Failed to fetch segments:
TypeError: WeakMap key "timeupdate" must be an object or an unregistered symbol
```

### Cause racine

PeerTube v8 encapsule le player Video.js dans un wrapper qui utilise des **WeakMaps** pour son système d'événements. Quand le code appelle `player.on('timeupdate', fn)`, le wrapper tente d'utiliser la string `"timeupdate"` comme clé d'un WeakMap, ce qui échoue car les WeakMaps n'acceptent que des objets ou des symboles non enregistrés comme clés.

Les méthodes Video.js suivantes ne fonctionnent plus via le wrapper PeerTube v8 :
- `player.on(eventName, handler)`
- `player.one(eventName, handler)`
- `player.currentTime()` / `player.currentTime(value)`
- `player.duration()`
- `player.controlBar.progressControl.seekBar` (peut être undefined)

### Correction proposée

Utiliser l'élément HTML5 `<video>` natif au lieu du wrapper Video.js de PeerTube :

```javascript
// ❌ Code actuel (ne fonctionne pas sur PeerTube v8)
player.on('timeupdate', () => {
  const currentTime = player.currentTime()
  // ...
  player.currentTime(segment.end_time)
})

// ✅ Correction — accéder directement à l'élément <video> natif
const videoEl = player.el
  ? player.el().querySelector('video')
  : document.querySelector('.vjs-tech')

if (!videoEl) {
  console.error('[SponsorBlock] Could not find video element')
  return
}

videoEl.addEventListener('timeupdate', () => {
  const currentTime = videoEl.currentTime
  // ...
  videoEl.currentTime = segment.end_time
})
```

La même approche s'applique à `addProgressBarMarkers` :
- `player.duration()` → `videoEl.duration`
- `player.one('durationchange', fn)` → `videoEl.addEventListener('durationchange', fn, { once: true })`
- `player.controlBar.progressControl.seekBar.el()` → try/catch + fallback `document.querySelector('.vjs-progress-holder')`

### Diff complet (client-side)

<details>
<summary>client/video-watch.js</summary>

```diff
--- a/client/video-watch.js
+++ b/client/video-watch.js
@@ -89,10 +89,17 @@ function register({ registerHook, peertubeHelpers }) {
     if (skippingActive) return
     skippingActive = true

+    // Access the native HTML5 <video> element (PeerTube v8 wraps videojs)
+    const videoEl = player.el ? player.el().querySelector('video') : document.querySelector('.vjs-tech')
+    if (!videoEl) {
+      console.error('[SponsorBlock] Could not find video element')
+      return
+    }
+
     let lastCheckTime = 0

-    player.on('timeupdate', () => {
-      const currentTime = player.currentTime()
+    videoEl.addEventListener('timeupdate', () => {
+      const currentTime = videoEl.currentTime

       // Throttle checks to avoid performance issues
       if (Math.abs(currentTime - lastCheckTime) < 0.5) {
@@ -109,7 +116,7 @@ function register({ registerHook, peertubeHelpers }) {
           if (!skippedSegments.has(segmentKey)) {
             console.log(`[SponsorBlock] Skipping segment: ${segment.start_time}s - ${segment.end_time}s`)

-            player.currentTime(segment.end_time)
+            videoEl.currentTime = segment.end_time
             skippedSegments.add(segmentKey)

@@ -315,21 +322,27 @@ function addProgressBarMarkers(player) {
     if (!player || segments.length === 0) return

     try {
-      const progressControl = player.controlBar.progressControl
-      if (!progressControl) return
-      const seekBar = progressControl.seekBar
-      if (!seekBar) return
+      let seekBarEl
+      try {
+        seekBarEl = player.controlBar.progressControl.seekBar.el()
+      } catch {
+        seekBarEl = document.querySelector('.vjs-progress-holder')
+      }
+      if (!seekBarEl) return

-      const duration = player.duration()
-      if (!duration || duration === Infinity) {
-        player.one('durationchange', () => addProgressBarMarkers(player))
+      const videoEl = player.el ? player.el().querySelector('video') : document.querySelector('.vjs-tech')
+      if (!videoEl) return
+
+      const duration = videoEl.duration
+      if (!duration || duration === Infinity || isNaN(duration)) {
+        videoEl.addEventListener('durationchange', () => addProgressBarMarkers(player), { once: true })
         return
       }

-      const existingMarkers = seekBar.el().querySelectorAll('.sponsorblock-marker')
+      const existingMarkers = seekBarEl.querySelectorAll('.sponsorblock-marker')
       existingMarkers.forEach(marker => marker.remove())

       // ... (markers creation unchanged) ...

-        seekBar.el().appendChild(marker)
+        seekBarEl.appendChild(marker)
```

</details>

### Statut

**Correction implémentée mais non vérifiée** : Le fix a été déployé sur le serveur mais le navigateur de test continuait à charger l'ancienne version depuis son cache (même script de 5 328 octets vs 10 951 octets après correction). Un hard refresh (Ctrl+Shift+R) ou un vidage de cache complet est nécessaire pour vérifier.

---

## Notes supplémentaires

### Migration des vidéos existantes

Le plugin ne hook que les **nouveaux imports** via `filter:api.video.post-import-url.accept.result`. Pour les vidéos déjà importées depuis YouTube, il faut :

1. Soit utiliser la route `POST /scan` du plugin (qui scanne la table `videoImport`)
2. Soit insérer manuellement les mappings en requêtant la base PeerTube :

```sql
-- Trouver les imports YouTube
SELECT vi."targetUrl", v."uuid"
FROM "videoImport" vi
JOIN "video" v ON vi."videoId" = v."id"
WHERE vi."targetUrl" LIKE '%youtube%' OR vi."targetUrl" LIKE '%youtu.be%';
```

Sur notre instance : 221 imports YouTube trouvés, 20 avec des segments SponsorBlock.

### Rechargement du plugin après mise à jour

PeerTube copie les fichiers du plugin dans `/data/plugins/node_modules/peertube-plugin-sponsorblock/` lors de l'installation. Si le numéro de version (`package.json`) ne change pas, PeerTube ne re-copie pas les fichiers. Pour forcer la mise à jour :

```bash
# Copier les fichiers manuellement
docker exec <container> sh -c \
  "cp -r /app/peertube-plugin-sponsorblock/* /data/plugins/node_modules/peertube-plugin-sponsorblock/"

# Redémarrer PeerTube pour recharger le plugin
docker restart <container>
```

Ou bien incrémenter la version dans `package.json` et réinstaller via l'API.
