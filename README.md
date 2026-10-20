# PROJET RESTREINT — édition Cloudflare

Site de discussion responsive prévu pour **six comptes maximum** : un propriétaire et cinq membres. Design noir/violet avec étoiles animées, comptes individuels, salon général, messages directs, pièces jointes, notes vocales, réponses, réactions et présence approximative.

## Très important avant le déploiement

Cette archive contient le projet complet, mais Cloudflare doit être connecté à **ta propre base D1** et recevoir un secret propriétaire. Ce sont des informations propres à ton compte; elles ne peuvent pas être préremplies dans le ZIP.

Le dépôt GitHub de ce projet est public : **ne mets jamais le code secret du propriétaire, un mot de passe, un cookie ou un jeton Cloudflare dans GitHub**.

## 1. Créer la base Cloudflare D1

1. Ouvre `https://dash.cloudflare.com/`.
2. Va dans **Workers & Pages** (ou **Storage & databases → D1** selon l'interface).
3. Crée une base de données appelée exactement `projet-restreint-db`.
4. Ouvre cette base, puis sa **Console**.
5. Ouvre le fichier `schema.sql` de cette archive, copie tout son contenu dans la console D1 et exécute-le.
6. Dans les détails de la base, copie son **Database ID**.

## 2. Renseigner le Database ID

1. Ouvre `wrangler.jsonc` dans un éditeur de texte.
2. Trouve cette ligne :
   `"database_id": "00000000-0000-0000-0000-000000000000"`
3. Remplace uniquement le faux identifiant par le vrai **Database ID** de ta base D1.
4. Enregistre le fichier.

Ne déploie pas tant que ce remplacement n'a pas été fait : l'identifiant inclus dans le ZIP est un marqueur provisoire.

## 3. Configurer le code secret du propriétaire

Dans Cloudflare, ouvre **Workers & Pages → projet-restreint → Settings → Variables and Secrets** et ajoute un secret (pas une variable publique) nommé exactement :

`OWNER_SETUP_CODE`

Choisis un code long, unique et difficile à deviner. Ne l'écris jamais dans `app.js`, `index.html`, `wrangler.jsonc`, ni dans GitHub. Le code sera demandé seulement pour créer le tout premier compte propriétaire. Après l'inscription, les membres devront utiliser les codes d'invitation à usage unique générés dans le site.

## 4. Envoyer les fichiers dans GitHub

Décompresse l'archive sur ton PC. Ouvre PowerShell dans le dossier où se trouve le projet. Si le dépôt est déjà cloné dans `Desktop\projet-restreint`, copie les fichiers de l'archive dans ce dossier en remplaçant les anciens fichiers, puis utilise :

```powershell
git add .
git commit -m "Complete PROJET RESTREINT application"
git push
```

Si Git répond qu'il n'y a rien à commit, vérifie que les nouveaux fichiers ont bien été copiés dans le dépôt cloné.

Le dépôt GitHub cible est `https://github.com/DREDOS2133/projet-restreint`.

## 5. Déployer depuis Cloudflare

Ouvre **Workers & Pages → projet-restreint → Deployments** et vérifie le dernier déploiement.

Si le déploiement échoue avec un message sur l'API token révoqué/supprimé, retourne dans **Settings → Builds → API token**, crée un nouveau jeton de déploiement depuis l'option proposée par Cloudflare puis relance le déploiement. Ne copie pas ce jeton dans le dépôt ou dans le chat.

Quand le déploiement réussit, l'adresse `workers.dev` de ton Worker doit afficher l'écran de connexion. Pour vérifier l'API, ouvre `/api/health` à la fin de la même adresse. L'API répond avec `"ok": true` si la base D1 est correctement configurée.

## 6. Créer le premier compte, puis inviter les membres

1. Ouvre le site et choisis **Créer un compte**.
2. Crée l'identifiant du propriétaire (3 à 20 caractères : lettres, chiffres ou `_`), un mot de passe de 10 caractères minimum et le secret `OWNER_SETUP_CODE` défini dans Cloudflare.
3. Connecte-toi. Dans la barre latérale, clique sur **Créer une invitation**.
4. Transmets chaque code en privé à la personne prévue. Chaque code d'invitation ne peut être utilisé qu'une fois.
5. Le serveur refuse les inscriptions au-delà de six comptes au total.

## Fonctions incluses

- Comptes séparés, sessions via cookie HttpOnly/Secure/SameSite et mots de passe hachés PBKDF2-SHA-256.
- Compte propriétaire initial protégé par un secret conservé sur le serveur.
- Invitations à usage unique; limite de six membres.
- Salon général et messages privés entre membres.
- Mise à jour des messages toutes les quelques secondes, historique récent et état en ligne approximatif.
- Réponse à un message, modification de ses propres messages pendant 15 minutes, suppression de ses messages; le propriétaire peut supprimer ceux des autres.
- Réactions emoji.
- Partage de photos, PDF et messages vocaux courts (environ 900 Ko maximum par fichier).
- Interface adaptée aux ordinateurs et aux téléphones.

## Limites à connaître

- Les pièces jointes sont stockées dans D1 comme données encodées pour cette version; limite pratique d'environ 900 Ko. Pour les gros fichiers, il faudra connecter Cloudflare R2.
- Les mises à jour utilisent une interrogation périodique (environ 3,5 secondes), pas WebSocket.
- Les notifications du navigateur dépendent de ses autorisations et ne sont pas garanties si le navigateur est complètement fermé.
- Les messages ne sont pas chiffrés de bout en bout. N'utilise pas ce projet pour des informations extrêmement sensibles sans audit et améliorations supplémentaires.
- La limitation des tentatives de connexion et les sauvegardes automatiques doivent être ajoutées pour un usage plus exigeant.
