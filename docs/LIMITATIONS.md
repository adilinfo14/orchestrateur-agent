# Limitations et choix techniques

Audit réalisé le 26/10/2026 sur la documentation officielle (code.claude.com/docs) et Claude Code 2.1.30x.
Chaque capacité est classée : **documentée**, **observée mais non documentée**, ou **impossible**.

## Sources de données

| Source | Statut | Usage |
|---|---|---|
| Hooks HTTP (`SessionStart`, `PreToolUse`, `SubagentStart`, `Notification`…) | Documentée | Source principale de tous les événements |
| Agent SDK (`query`, `canUseTool`, `interrupt`) | Documentée | Sessions lancées par le cockpit |
| `claude agents --json` | Documentée (préversion) | Sessions en arrière-plan, si la commande `claude` est installée |
| `~/.claude/sessions/<pid>.json` | **Non documentée** | Détection des sessions déjà ouvertes avant les hooks. Lecture seule, désactivable (`useSessionRegistry: false`), signalée dans l'interface. Les fichiers `.key` ne sont jamais lus |
| Journaux `~/.claude/projects/*.jsonl` | Format interne, instable | **Non utilisés**. La documentation précise qu'ils changent d'une version à l'autre |

Les fichiers modifiés sont déduits des appels `Write` / `Edit` / `NotebookEdit` remontés par
`PostToolUse`, jamais d'une lecture de fichiers internes.

## Pilotage

### Sessions lancées par le cockpit (Agent SDK) : contrôle complet
Envoi d'instructions, interruption, arrêt, relais des demandes d'autorisation. Les règles de
permission de Claude Code s'appliquent normalement (règles deny/ask, puis mode, puis `canUseTool`) :
par exemple, une commande déjà autorisée par vos règles (`Bash(ls *)`) ne déclenche pas de validation.

### Sessions interactives (VS Code, terminal) : envoi d'instructions uniquement
- **Envoi** : par l'*inbox socket* de la session (messagerie entre sessions, documentée). Les hooks
  reçoivent `CLAUDE_CODE_MESSAGING_SOCKET` et `CLAUDE_CODE_MESSAGING_TOKEN`, que le hook HTTP transmet
  au collecteur local (ils ne quittent jamais la machine).
  - La ligne d'authentification est documentée. Le format du message (`{"type":"user",…}`) est celui
    qu'indique Claude Code lui-même dans son journal de débogage (`[uds-messaging] Inject messages`) ;
    il a été validé en conditions réelles.
  - Le message arrive comme venant d'une autre session : il **ne peut rien approuver**, ne peut pas
    modifier la configuration, et les commandes `/…` qu'il contient ne sont pas exécutées.
  - La session applique ses contrôles d'entrée (`crossSessionInbound`). Une session en
    `bypassPermissions` peut mettre le message en attente ; le collecteur ne peut pas observer ce
    cas, et la commande est alors marquée « déposée », pas « exécutée ».
- **Interruption / arrêt** : **impossible** de manière documentée depuis l'extérieur. Le cockpit ne tue
  pas de processus.
- **Validation des autorisations** : techniquement possible via un hook `PermissionRequest`, mais
  **volontairement non implémenté** pour les sessions interactives. Le cockpit ne contourne pas les
  demandes de Claude Code : validez dans l'interface de la session ou via Remote Control.

### Sessions ouvertes avant l'installation des hooks
Visibles grâce au registre local (statut approximatif), sans historique ni contrôle. En pratique,
Claude Code recharge les réglages à chaud et une session ouverte commence souvent à émettre dès
l'installation ; sinon, il faut la redémarrer.

## Remote Control

- Aucune **API publique** ne permet de lister ou de piloter les sessions Remote Control.
- Ce qui est possible : démarrer Remote Control (`claude --rc`, `/remote-control`, ou
  `claude remote-control` en mode serveur) puis utiliser l'app Claude sur iPhone. Exigences : forfait
  Pro, Max, Team ou Enterprise, connexion claude.ai (pas de clé d'API), une seule session distante par
  processus interactif.
- Le cockpit et Remote Control sont **complémentaires** : le cockpit donne la vue globale
  multi-machines et l'envoi d'instructions ; Remote Control permet de répondre aux dialogues
  (autorisations, questions) d'une session précise depuis l'iPhone.

## Différences entre plateformes

- **Windows natif** : hooks HTTP identiques (aucun shell impliqué) ; inbox en *named pipe*, jeton
  obligatoire (transmis automatiquement).
- **WSL 2** : `~/.claude` distinct de Windows → collecteur séparé. Une session WSL et une session
  Windows ne peuvent pas s'envoyer de messages entre elles.
- **Commande `claude`** : absente du PATH sur le Mac au moment de l'audit (seul le binaire intégré à
  VS Code tournait). Sans elle, la source `claude agents --json` est désactivée ; le reste fonctionne.

## Orchestration

- La décomposition est faite par une vraie session Claude Code lancée en **mode plan** (lecture seule).
  Elle consomme l'abonnement comme une session normale.
- Une tâche est distribuée uniquement à une session **au repos**, afin que le prochain « tour terminé »
  observé corresponde bien à la tâche.
- Statuts honnêtes :
  - **Annoncée terminée** : la session a fini son tour (`Stop`). Ce n'est pas une preuve.
  - **Vérifiée** : la commande de preuve (ex. `npm test`) a été exécutée **avec succès dans la session
    assignée, après l'envoi de la tâche**, d'après `PostToolUse`. Ou validation manuelle avec
    justification, tracée dans l'audit.
  - Une tâche sans commande de preuve compte comme satisfaite pour ses dépendances dès qu'elle est
    annoncée terminée, mais elle reste affichée « sans preuve ».
- Pas de pourcentage d'avancement : aucune source fiable ne le fournit.

## Préversions

La vue agents (`claude agents`) et les *channels* sont en préversion et peuvent changer. Le canal
d'inbox est documenté, mais le format exact du message n'est que partiellement décrit : à surveiller
lors des mises à jour de Claude Code (le test de bout en bout `e2e.test.ts` vérifie notre côté du protocole).
