# Installation

## 1. Serveur central

Le serveur est déployé sur le home lab (`confia-vm`, Ubuntu 24.04) avec Docker Compose.
Il n'écoute **que sur l'IP Tailscale** de la machine (`ACC_BIND_IP`) : il n'est joignable ni depuis
Internet ni depuis le réseau local.

```bash
# Sur le poste de développement : copier le code (ou git clone sur le serveur)
rsync -az --delete --exclude node_modules --exclude 'apps/web/dist' --exclude .git --exclude .env \
  ./ confia-vm:agent-command-center/

# Sur le serveur
cd ~/agent-command-center
printf "ACC_BIND_IP=100.106.236.17\nACC_PORT=7820\n" > .env
docker compose up -d --build
```

Le conteneur utilise le réseau `host` : aucun réseau Docker supplémentaire n'est créé (le daemon du
home lab n'avait plus de plage d'adresses libre).

### Créer votre compte

```bash
ssh -t confia-vm 'docker exec -it agent-command-center node apps/server/src/admin.ts set-password <utilisateur>'
```

Interface : **http://100.106.236.17:7820** (ou `http://adil-vmware20-1.tail5cce17.ts.net:7820`).

Autres commandes d'administration : `users`, `delete-user <utilisateur>`, `enroll-code`, `machines`.

### HTTPS (recommandé)

Le trafic est déjà chiffré de bout en bout par WireGuard (Tailscale). Pour obtenir en plus une URL
`https://` (cookies `Secure`, installation PWA complète sur iPhone) :

1. Console Tailscale → *DNS* → activer **HTTPS Certificates**.
2. Sur le serveur : `sudo tailscale serve --bg --https=443 http://100.106.236.17:7820`
3. Dans `.env` : `ACC_SECURE_COOKIES=1` et `ACC_TRUST_PROXY=1`, puis `docker compose up -d`.

### Variables

| Variable | Défaut | Rôle |
|---|---|---|
| `ACC_BIND_IP` | (obligatoire) | Adresse d'écoute (IP Tailscale) |
| `ACC_PORT` | 7820 | Port |
| `ACC_RETENTION_DAYS` | 30 | Durée de conservation des événements bruts |
| `ACC_SECURE_COOKIES` | 0 | Cookies `Secure` (à activer derrière HTTPS) |
| `ACC_TRUST_PROXY` | 0 | Faire confiance à `X-Forwarded-For` (uniquement derrière `tailscale serve`) |

## 2. Collecteurs

Prérequis sur chaque machine : Node.js ≥ 22.18, Claude Code, Tailscale connecté, une copie du dépôt.

### Inscription (commune à toutes les plateformes)

1. Dans l'interface : **Machines → Ajouter une machine**. Un code à usage unique (15 min) est affiché
   avec les commandes prêtes à copier.
2. Sur la machine :

```bash
npm install
node apps/collector/src/cli.ts enroll --server http://100.106.236.17:7820 --code XXXXX-XXXXX \
  --name "Mac mini" --allow-root ~/basketvision --allow-root ~/recto
node apps/collector/src/cli.ts install-hooks
```

`--allow-root` limite les dossiers dans lesquels le cockpit peut **lancer** des sessions. Sans racine,
le lancement est désactivé sur la machine. Ajout ultérieur : `node apps/collector/src/cli.ts allow-root <dossier>`.

`install-hooks` ajoute des hooks HTTP dans `~/.claude/settings.json`. Une sauvegarde
(`settings.json.acc-backup-<horodatage>`) est créée, vos autres réglages et hooks ne sont pas modifiés.
Retrait : `node apps/collector/src/cli.ts uninstall-hooks`.

### macOS : service launchd

```bash
./scripts/install-collector-macos.sh      # démarre à la connexion, relance automatique
tail -f ~/.acc/collector.log
```

### Windows natif : tâche planifiée

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-collector-windows.ps1
Get-Content $HOME\.acc\collector.log -Wait
```

Les hooks HTTP ne passent par aucun shell : ils fonctionnent à l'identique avec ou sans Git Bash.
L'inbox socket est un *named pipe* sous Windows ; le jeton exporté par Claude Code est transmis
automatiquement (obligatoire sur cette plateforme).

### WSL 2 : service systemd utilisateur

WSL est traité comme **une machine distincte** : Claude Code y a son propre `~/.claude` et ses propres
sessions, et une session WSL ne peut pas recevoir de message d'une session Windows. Installez donc
un collecteur dans WSL **en plus** de celui de Windows (avec son propre code d'inscription), si vous
y lancez Claude Code.

```bash
# dans WSL, systemd activé (/etc/wsl.conf : [boot] systemd=true)
./scripts/install-collector-wsl.sh
```

## 3. iPhone

- Ouvrez `http://100.106.236.17:7820` dans Safari (Tailscale actif sur l'iPhone), puis
  *Partager → Sur l'écran d'accueil*. L'interface est adaptée au mobile (barre de navigation inférieure).
- Pour répondre directement à une session depuis l'app Claude, utilisez **Remote Control**
  (`/remote-control` dans la session, ou `claude --rc`). Voir [LIMITATIONS.md](LIMITATIONS.md#remote-control).

## 4. Développement local

```bash
ACC_DATA_DIR=./data npm run dev:server         # API sur 127.0.0.1:7820
npm run dev:web                                # interface sur http://localhost:5173 (proxy vers l'API)
npm run admin -w @acc/server -- set-password moi
```
