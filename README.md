# PeerTube Plugin SponsorBlock

Plugin PeerTube pour intégrer SponsorBlock et sauter (ou supprimer) automatiquement les segments sponsorisés des vidéos importées depuis YouTube.

## 🎯 Objectif

Permettre aux instances PeerTube de bénéficier de la base de données crowdsourcée SponsorBlock pour améliorer l'expérience de visionnage des vidéos importées depuis YouTube.

## 📋 Statut du projet

**🚧 En phase de recherche et développement**

Ce projet est actuellement en phase de conception. Consultez les documents de recherche :
- [`RESEARCH.md`](./RESEARCH.md) - Recherche sur l'état de l'art et les capacités PeerTube
- [`TECHNICAL_ANALYSIS.md`](./TECHNICAL_ANALYSIS.md) - Analyse technique de la suppression permanente des segments

## ✨ Fonctionnalités prévues

### Phase 1 : MVP (Skip côté client)
- ✅ Détection automatique de l'ID YouTube lors de l'import
- ✅ Récupération des segments SponsorBlock via API
- ✅ Saut automatique des segments dans le lecteur vidéo
- ✅ Cache local des segments
- ✅ Configuration par catégorie (sponsor, intro, outro, etc.)

### Phase 2 : Améliorations
- Interface d'administration pour gérer les mappings
- Synchronisation périodique avec SponsorBlock
- Support des vidéos déjà importées (migration)
- Statistiques et métriques
- Indicateurs visuels sur la timeline

### Phase 3 : Suppression permanente (optionnel)
- Modification des fichiers vidéo pour supprimer définitivement les segments
- Traitement FFmpeg en arrière-plan
- Économie de stockage et bande passante

## 🏗️ Architecture

### Composants principaux

1. **Table de mapping YouTube ↔ PeerTube**
   ```sql
   plugin_sponsorblock_mapping (peertube_uuid, youtube_id)
   ```

2. **Cache de segments SponsorBlock**
   ```sql
   plugin_sponsorblock_segments (youtube_id, start_time, end_time, category)
   ```

3. **Hooks d'import**
   - Capture l'ID YouTube lors de l'import
   - Récupération automatique des segments

4. **Intégration lecteur vidéo**
   - Skip automatique lors de la lecture
   - Notifications visuelles

## 📚 Documentation de recherche

### État de l'art

**Aucun plugin SponsorBlock natif pour PeerTube n'existe actuellement.**

Projets similaires :
- **peertube-plugin-chapters** : Chapitres manuels (non crowdsourcés)
- **Tubular** : App Android avec support SponsorBlock + PeerTube

Feature requests ouvertes depuis 2020 :
- [ajayyy/SponsorBlock#1209](https://github.com/ajayyy/SponsorBlock/issues/1209)
- [ajayyy/SponsorBlock#1938](https://github.com/ajayyy/SponsorBlock/issues/1938)
- [ajayyy/SponsorBlock#993](https://github.com/ajayyy/SponsorBlock/issues/993)

### Capacités PeerTube

Le système de plugins PeerTube supporte :
- ✅ Hooks d'import (`filter:api.video.post-import-url.accept.result`)
- ✅ Hooks lecteur vidéo (`action:video-watch.video.loaded`)
- ✅ Accès base de données (création de tables personnalisées)
- ✅ Requêtes HTTP externes (API SponsorBlock)
- ✅ Modification de l'interface utilisateur

## 🛠️ Technologies

- **PeerTube** : Plateforme vidéo décentralisée
- **SponsorBlock API** : https://sponsor.ajay.app/api/
- **FFmpeg** : Pour la suppression permanente (phase 3)
- **PostgreSQL** : Base de données PeerTube
- **Node.js** : Runtime du plugin

## 📖 Ressources

### Documentation PeerTube
- [Guide des plugins](https://docs.joinpeertube.org/contribute/plugins)
- [API Plugins](https://docs.joinpeertube.org/api/plugins)
- [Architecture](https://docs.joinpeertube.org/contribute/architecture)

### SponsorBlock
- [Documentation API](https://wiki.sponsor.ajay.app/w/API_Docs)
- [Code source](https://github.com/ajayyy/SponsorBlock)

## 🤝 Contribution

Ce projet est en phase de recherche. Les contributions sont bienvenues :
- Retours d'expérience sur PeerTube
- Expertise FFmpeg
- Tests sur instances PeerTube de développement

## 📄 Licence

À définir (probablement AGPL-3.0 pour compatibilité avec PeerTube)

## ⚠️ Avertissements

### Mode "Skip" (Phase 1)
- Les segments sont toujours téléchargés (pas d'économie de bande passante)
- Fonctionne uniquement dans le lecteur web PeerTube

### Mode "Suppression permanente" (Phase 3)
- ⚠️ Modification irréversible des fichiers vidéo
- Charge CPU importante (FFmpeg)
- Risques de corruption en cas d'erreur
- Timestamps de commentaires décalés
- **Recommandé uniquement avec backups automatiques**

---

**Auteur** : À compléter
**Date de création** : 2026-01-31
