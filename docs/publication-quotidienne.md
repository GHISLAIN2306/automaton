# Agent de publication quotidienne

Chaque jour, le workflow GitHub Actions « Vidéo quotidienne » (`.github/workflows/daily-video.yml`) :

1. demande à Gemini un script sur un **nouveau sujet** de la niche (jamais un titre déjà traité, refus des quasi-doublons) ;
2. fabrique la vidéo verticale : voix naturelle, une image par scène avec zoom lent, sous-titres, mention permanente « Contenu généré par IA » (environ 0,29 $) ;
3. la publie sur **YouTube Shorts, TikTok et Instagram Reels** via les API officielles, en la déclarant comme contenu IA (`containsSyntheticMedia` sur YouTube, `is_aigc` sur TikTok, mention dans la légende sur Instagram) ;
4. enregistre le script et les liens dans `content/videos/` et garde la vidéo 30 jours dans les artefacts du workflow.

Les plafonds de dépense restent actifs : 0,50 $ par vidéo et 30 $ par mois. Une vidéo de moins de 61 secondes n'est pas publiée.

## Démarrer, arrêter

- **Essai sans publier** : onglet Actions → « Vidéo quotidienne » → « Run workflow », case « Publier » décochée. La vidéo est téléchargeable dans les artefacts du run.
- **Publier une fois à la main** : même chose avec « Publier » cochée.
- **Publication automatique tous les jours** (vers 18 h 17 à Paris) : Settings → Secrets and variables → Actions → onglet Variables → `AUTOMATON_PUBLISH_ENABLED` = `true`.
- **Arrêter** : mettre cette variable à `false`.

Sur un fork, il faut aussi activer les workflows une fois dans l'onglet Actions.

## Secrets à créer (Settings → Secrets and variables → Actions → Secrets)

Une plateforme dont les secrets manquent est simplement ignorée.

| Secret | Où l'obtenir |
|---|---|
| `GEMINI_API_KEY` | aistudio.google.com/app/apikey (facturation activée) |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | Google Cloud Console → projet → « YouTube Data API v3 » activée → Identifiants → ID client OAuth (type « Application de bureau ») |
| `YOUTUBE_REFRESH_TOKEN` | jeton obtenu une fois avec l'autorisation `https://www.googleapis.com/auth/youtube.upload` (par exemple via OAuth Playground avec vos propres identifiants) |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | developers.tiktok.com → votre app → produits « Login Kit » et « Content Posting API » (Direct Post), autorisation `video.publish` |
| `TIKTOK_REFRESH_TOKEN` | jeton obtenu une fois en connectant votre compte TikTok à l'app |
| `INSTAGRAM_ACCESS_TOKEN` | developers.facebook.com → app → « Instagram API with Instagram Login », compte professionnel (Créateur ou Entreprise), autorisations `instagram_business_basic` et `instagram_business_content_publish`, jeton longue durée |
| `INSTAGRAM_USER_ID` | facultatif, retrouvé automatiquement sinon |
| `SECRETS_ADMIN_TOKEN` | facultatif mais conseillé : jeton GitHub « fine-grained » limité à ce dépôt, droit « Secrets : Read and write ». Il permet d'enregistrer les jetons TikTok et Instagram renouvelés. |

Variables facultatives : `AUTOMATON_NICHE` (description de la niche), `YOUTUBE_PRIVACY` (`public` par défaut), `TIKTOK_PRIVACY` (`PUBLIC_TO_EVERYONE` par défaut).

## Limites imposées par les plateformes

- **YouTube** : tant que le projet Google Cloud n'a pas passé l'audit des API YouTube, les vidéos envoyées par l'API restent **privées**. En mode « Test » de l'écran de consentement OAuth, le jeton expire au bout de 7 jours : passez l'application « En production ».
- **TikTok** : tant que l'app n'a pas passé l'audit de TikTok, les publications sont **privées** (visibles seulement par vous). L'agent publie alors en privé au lieu d'échouer.
- **Instagram** : l'app peut rester en mode développement si c'est votre propre compte qui publie ; 50 publications par jour au maximum.
- **Contenu IA produit en masse** : YouTube et TikTok sanctionnent la production à la chaîne de vidéos répétitives. L'agent limite ce risque (un sujet différent chaque jour, refus des quasi-doublons, étiquetage IA), mais ne le supprime pas.
