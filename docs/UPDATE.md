# Procédure de mise à jour

## Serveur central (home lab)

```bash
# depuis le poste de développement, à la racine du dépôt à jour
git pull
npm test
rsync -az --delete --exclude node_modules --exclude 'apps/web/dist' --exclude .git --exclude .env \
  ./ confia-vm:agent-command-center/
ssh confia-vm 'cd agent-command-center && docker compose up -d --build'
```

Les données (volume `acc-data`) sont conservées. Le schéma SQLite est créé et complété
automatiquement au démarrage (`CREATE TABLE IF NOT EXISTS`).

Sauvegarde avant une mise à jour majeure :

```bash
ssh confia-vm 'docker run --rm -v agent-command-center_acc-data:/d -v $PWD:/b alpine tar czf /b/acc-backup-$(date +%F).tgz -C /d .'
```

Les commandes en vol au moment du redémarrage sont marquées « sans réponse » : aucun résultat n'est inventé.

## Collecteurs

```bash
git pull && npm install
# macOS
launchctl kickstart -k gui/$(id -u)/com.agent-command-center.collector
# Windows (PowerShell)
Stop-ScheduledTask AgentCommandCenterCollector; Start-ScheduledTask AgentCommandCenterCollector
# WSL
systemctl --user restart acc-collector
```

Le journal d'envoi local conserve les événements pendant le redémarrage : rien n'est perdu.
Si la liste des hooks évolue, relancez `node apps/collector/src/cli.ts install-hooks` (opération idempotente).

## Après une mise à jour de Claude Code

1. Vérifier que les sessions continuent d'émettre (Vue d'ensemble → « Dernière activité »).
2. Tester l'envoi d'une instruction à une session interactive : le format de l'inbox socket n'est que
   partiellement documenté (voir LIMITATIONS.md).
3. `npm test` valide le protocole côté cockpit ; en cas de changement côté Claude Code, ajuster
   `apps/collector/src/socket-send.ts`.
