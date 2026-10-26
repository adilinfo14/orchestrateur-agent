# Architecture

## Composants

### Collecteur (`apps/collector`), un par machine (et un par distribution WSL)
- **Récepteur de hooks** : HTTP sur `127.0.0.1:47821`, protégé par un secret local (en-tête
  `X-ACC-Token`). Répond toujours `200` avec un corps vide : il n'influence jamais une décision de
  Claude Code.
- **Journal d'envoi** (`~/.acc/outbox.db`, SQLite) : chaque événement reçoit un numéro de séquence
  monotone. Il est conservé jusqu'à l'accusé de réception du serveur, ce qui couvre les coupures
  réseau et les redémarrages (plafond : 200 000 événements, les plus anciens sont abandonnés au-delà).
- **Lien montant** : WebSocket sortant vers le serveur, jeton machine en `Authorization: Bearer`,
  reconnexion avec backoff exponentiel (1 s → 30 s) et gigue, battement de cœur 15 s.
- **Sessions SDK** : `@anthropic-ai/claude-agent-sdk`, entrée en streaming, `canUseTool` relayé à l'interface.
- **Envoi par inbox socket** vers les sessions interactives.
- **Détection** : registre `~/.claude/sessions` (toutes les 5 s) et `claude agents --json` (toutes les 10 s).
- **Politique locale** (`~/.acc/collector.json`) : `allowSend`, `allowSpawn`, `allowedRoots`,
  `allowPermissionRelay`. Elle prévaut toujours sur le serveur.

### Serveur central (`apps/server`)
- Fastify 5, `@fastify/websocket`, SQLite intégré (`node:sqlite`, mode WAL).
- **Ingestion idempotente** : `INSERT OR IGNORE` sur `(machine_id, seq)` et sur l'identifiant
  d'événement. Un renvoi après reconnexion n'a aucun effet de bord.
- **Réduction d'état** (`reducer.ts`, fonction pure) : statut, tâche courante, attente, erreurs,
  canaux de contrôle. Les canaux ne sont ouverts que sur preuve (`SessionChannel`,
  `ManagedSessionStarted`).
- **Commandes** (`commands.ts`) : validation, clé d'idempotence, verrou (une commande en vol par
  session), confirmation obligatoire des opérations sensibles, délai d'expiration, audit.
  Une commande n'est jamais marquée réussie sans réponse explicite du collecteur ; une déconnexion
  donne « résultat inconnu ».
- **Orchestrateur** (`orchestrator.ts`) : plans, tâches, dépendances (graphe acyclique vérifié),
  distribution, suivi par preuves.

### Interface (`apps/web`)
- React 19, Tailwind 4, React Flow (chargé à la demande), TanStack Virtual pour la chronologie.
- Store temps réel minimal (`useSyncExternalStore`) ; les mises à jour sont regroupées par frame
  d'animation. À chaque reconnexion, l'état complet est rechargé (`/api/bootstrap`) : aucune mise à
  jour manquée ne laisse d'affichage périmé.

## Protocole

Enveloppe d'événement (`packages/protocol`) :

```ts
{ id: uuid, machineId, seq, ts, source: 'hook'|'sdk'|'registry'|'agents-cli'|'collector',
  type, sessionId, agentId, cwd, data }
```

Collecteur → serveur : `hello` (capacités annoncées), `events` (lots ≤ 200, fenêtre d'un lot),
`cmd.result`, `ping`. Serveur → collecteur : `welcome {ackSeq}`, `ack {seq}`, `cmd`, `pong`.

Serveur → interface : `event`, `session`, `agent`, `machine`, `command`, `plan`.

## Réduction des statuts

| Événement | Effet |
|---|---|
| `SessionStart` | inactive |
| `UserPromptSubmit` | active, tâche courante = la demande |
| `PreToolUse` | active, dernier outil |
| `PermissionRequest`, `Notification(permission_prompt)` | en attente |
| `Notification(idle_prompt)` | inactive |
| `Stop` | inactive, dernier message |
| `StopFailure`, `TurnResult(is_error)` | erreur |
| `SessionEnd`, `ManagedSessionClosed`, processus disparu | terminée |
| `SubagentStart` / `SubagentStop` | relation parent → sous-agent (seule source de relation) |

Le statut issu du registre (non documenté) n'est utilisé qu'en l'absence d'observation par les hooks.

## Performances
- Événements bornés à la source (chaînes ≤ 4 000 caractères, contenus de fichiers ≤ 600).
- Index SQLite par date, session, machine et type ; pagination par curseur `(ts, id)`.
- Interface : rendu groupé par frame, liste virtualisée, graphe avec `onlyRenderVisibleElements`,
  composants mémorisés.
- Rétention : événements bruts purgés après 30 jours ; les états réduits sont conservés.
