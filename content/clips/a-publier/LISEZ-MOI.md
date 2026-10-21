# Extraits DramaCPS à publier

Déposez ici les extraits fournis par DramaCPS (fichiers `.mp4`, 25 Mo maximum par fichier quand on passe par le site GitHub) :
**Add file → Upload files**, puis « Commit changes ».

L'agent publie jusqu'à 2 extraits par jour, dans l'ordre alphabétique des noms de fichier, puis 1 mini-drame IA. Tant qu'il n'y a aucun extrait ici, il publie 2 mini-drames IA par jour.

Pour choisir l'accroche affichée pendant les 3 premières secondes, ajoutez un fichier `.json` qui porte le même nom que la vidéo (par exemple `serie-milliardaire-1.json` à côté de `serie-milliardaire-1.mp4`) :

```json
{
  "series": "Le milliardaire caché",
  "hook": "Elle ne savait pas que son mari était milliardaire…",
  "caption": "Tu veux savoir la suite ? 👀 Lien en bio 🎬",
  "hashtags": ["minisérie", "drama", "milliardaire", "dramaexpress"],
  "dramaId": "660219",
  "dramaUrl": "le Drama URL copié dans l'onglet Links de DramaCPS"
}
```

Avec `dramaUrl`, la série reçoit un numéro sur la page du lien en bio (https://ghislain2306.github.io/automaton/suite/) et la légende devient « Lien en bio, série n° 3 ». Plusieurs extraits d'une même série gardent le même numéro.

Tous les champs sont facultatifs. Sans accroche, l'agent affiche « Regarde bien sa réaction à la fin ». Une fois l'extrait publié partout, il est supprimé d'ici.
