# TODO

## Phase 1 : MVP (Client-side skip) - En cours

### Terminé ✅
- [x] Structure du projet
- [x] Package.json avec métadonnées PeerTube
- [x] Tables de base de données
- [x] Hook d'import YouTube
- [x] Extraction de l'ID YouTube
- [x] Intégration API SponsorBlock
- [x] Cache des segments en DB
- [x] Client-side skip logic
- [x] Marqueurs sur la barre de progression
- [x] Notifications de skip
- [x] API REST pour récupérer les segments
- [x] Paramètres du plugin
- [x] Traductions (EN, FR)
- [x] CSS pour les marqueurs
- [x] Documentation de développement

### À faire 🔨

#### Priorité haute
- [ ] Tester le plugin sur une instance PeerTube réelle
- [ ] Corriger les bugs identifiés lors des tests
- [ ] Ajouter la gestion des erreurs manquantes
- [ ] Valider la compatibilité Video.js
- [ ] Tester avec différentes catégories de segments

#### Priorité moyenne
- [ ] Améliorer les marqueurs visuels (couleurs par catégorie)
- [ ] Ajouter un bouton pour désactiver temporairement le skip
- [ ] Permettre de signaler un mauvais segment
- [ ] Statistiques : temps total économisé
- [ ] Support des playlists

#### Priorité basse
- [ ] Tests unitaires
- [ ] Tests d'intégration
- [ ] Linter (ESLint configuration)
- [ ] CI/CD (GitHub Actions)

## Phase 2 : Améliorations

### Interface d'administration
- [ ] Page admin pour voir tous les mappings
- [ ] Recherche de vidéos par YouTube ID
- [ ] Bouton pour forcer la synchronisation
- [ ] Logs d'activité du plugin
- [ ] Dashboard avec statistiques

### Migration et sync
- [ ] Script pour migrer les vidéos existantes
- [ ] Tâche cron pour sync périodique
- [ ] Détection des segments obsolètes
- [ ] Webhook si SponsorBlock supporte
- [ ] Import/export des mappings

### Fonctionnalités avancées
- [ ] Whitelist/blacklist de chaînes
- [ ] Paramètres par utilisateur
- [ ] Support des segments "mute" (au lieu de skip)
- [ ] Prévisualisation avant skip (bouton "skip")
- [ ] Historique des segments sautés

## Phase 3 : Suppression permanente (Optionnel)

### Analyse de faisabilité
- [ ] Vérifier l'accès aux fichiers vidéo depuis un plugin
- [ ] Tester FFmpeg depuis le contexte du plugin
- [ ] Valider les permissions nécessaires
- [ ] Mesurer l'impact performance sur le serveur

### Implémentation
- [ ] Worker de traitement de la queue
- [ ] Intégration FFmpeg (découpe et concat)
- [ ] Gestion des multiples résolutions
- [ ] Support des playlists HLS
- [ ] Système de backup automatique
- [ ] Rollback en cas d'erreur
- [ ] Gestion du stockage S3

### Sécurité et stabilité
- [ ] Transactions atomiques
- [ ] Vérification de l'intégrité des vidéos
- [ ] Limite de charge CPU
- [ ] File d'attente avec priorités
- [ ] Retry avec backoff exponentiel
- [ ] Monitoring et alertes

## Bugs connus

- Aucun pour l'instant (plugin non testé en production)

## Idées futures

- [ ] Support d'autres plateformes (Vimeo, Dailymotion)
- [ ] Soumission de nouveaux segments à SponsorBlock
- [ ] Segments générés par IA locale
- [ ] Intégration avec d'autres plugins PeerTube
- [ ] API pour clients mobiles
- [ ] Extension navigateur complémentaire
- [ ] Mode "preview" : montrer 2s du segment avant de skip

## Questions ouvertes

- **Performance** : Impact du skip sur la batterie mobile ?
- **UX** : Faut-il un bouton "ne plus sauter ce type de segment" ?
- **Légal** : Problèmes de droits d'auteur avec la suppression permanente ?
- **Technique** : Utiliser le système de jobs Bull de PeerTube ?
- **Communauté** : Héberger notre propre serveur SponsorBlock ?

## Notes

- Priorité : Sortir un MVP stable avant d'ajouter des features
- Garder le code simple et maintenable
- Documenter toutes les décisions techniques
- Tester sur plusieurs instances PeerTube
