# Sécurité

## Surface exposée
- **Serveur** : écoute uniquement sur l'IP Tailscale ; accessible seulement aux appareils du tailnet.
  Chiffrement WireGuard de bout en bout ; HTTPS en option via `tailscale serve`.
- **Collecteur** : aucun port entrant réseau. Le récepteur de hooks écoute sur `127.0.0.1` et exige un
  secret local. La connexion au serveur est toujours sortante.
- **Aucun shell ni exécution arbitraire n'est exposé** : le collecteur n'accepte que cinq commandes
  typées (`session.send`, `session.interrupt`, `session.stop`, `session.spawn`, `permission.respond`).

## Authentification et autorisations
- Utilisateurs : mot de passe haché avec scrypt (N=2^15), cookie de session `HttpOnly`,
  `SameSite=Strict` (et `Secure` derrière HTTPS), valable 30 jours, haché côté serveur. Changer le mot
  de passe révoque toutes les sessions ouvertes. Connexion limitée à 8 tentatives par minute et par IP.
- Anti-CSRF : en-tête `X-ACC-CSRF` exigé sur toute requête modifiante (pas de CORS) ; contrôle de
  l'origine sur le WebSocket.
- Machines : inscription par code à usage unique (15 min, seul son hachage est stocké), puis jeton
  propre à la machine (haché côté serveur). Révocation immédiate depuis l'interface. Un collecteur ne
  peut publier des événements que pour sa propre machine, et seules ses réponses aux commandes qui
  le visent sont prises en compte.
- Droits par machine : pilotage activable ou désactivable depuis le serveur. La politique locale du
  collecteur (racines autorisées, envoi, lancement, relais des autorisations) reste prioritaire.

## Commandes
- Opérations sensibles (lancement, arrêt, décision d'autorisation, droits machine, révocation) :
  confirmation exigée côté serveur, pas seulement dans l'interface.
- Idempotence par clé client, verrou par session, expiration, journal d'audit de chaque étape
  (création, refus, résultat, expiration).
- Lancement de sessions limité aux racines autorisées, vérifiées après normalisation des chemins
  (`..` et préfixes trompeurs refusés).

## Respect des permissions Claude Code
- Le récepteur de hooks ne renvoie jamais de décision.
- Les sessions SDK suivent la chaîne de permissions normale ; `canUseTool` n'est appelé que pour les
  actions que Claude Code soumet à validation, et chaque autorisation est confirmée par un humain.
- Les messages déposés dans une inbox ne peuvent rien approuver (garantie de Claude Code).
- Aucune écriture dans les fichiers internes de Claude Code ; le registre des sessions est lu seulement.

## Secrets
- `~/.acc/collector.json` (jeton machine, secret local) : permissions 0600, dossier 0700.
- Le jeton d'inbox de chaque session reste en mémoire dans le collecteur et ne quitte jamais la machine.
- Les entrées d'outils remontées peuvent contenir des données sensibles (commandes, chemins) :
  elles restent sur votre infrastructure, sont tronquées à la source et purgées après la durée de rétention.
