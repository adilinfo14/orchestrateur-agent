# Agent Command Center

Cockpit de supervision et de pilotage des sessions **Claude Code** réparties sur plusieurs machines
(macOS, Windows, WSL), accessible depuis un navigateur ou un iPhone.

- **Observation en temps réel** de toutes les sessions instrumentées : statut, tâche en cours, outils,
  fichiers modifiés, sous-agents, erreurs, demandes de validation.
- **Pilotage réel** des sessions compatibles : envoi d'instructions, interruption, arrêt, validation
  des autorisations, lancement de nouvelles sessions.
- **Orchestration** : décomposition d'un objectif en tâches, validation humaine, distribution selon
  les dépendances, suivi par preuves.
- **Aucune donnée simulée** : tout ce qui est affiché provient d'événements réellement collectés.
  Chaque session indique la source de ses données et les canaux de contrôle effectivement disponibles.

```
 Mac / Windows / WSL                                   Home lab (Docker)
 ┌──────────────────────────────┐   WSS sortant     ┌───────────────────────────┐
 │ Claude Code ──hooks HTTP──▶  │   jeton machine   │ Serveur central           │
 │ (127.0.0.1)   Collecteur ────┼──── Tailscale ───▶│ Fastify + SQLite          │◀── Navigateur / iPhone
 │ Agent SDK ◀── commandes      │   (WireGuard)     │ état · commandes · audit  │    (PWA, temps réel)
 └──────────────────────────────┘                   └───────────────────────────┘
```

## Démarrage rapide

```bash
npm install
npm test                       # 41 tests (unitaires + bout en bout)
```

- Serveur central : [docs/INSTALLATION.md](docs/INSTALLATION.md#1-serveur-central)
- Collecteurs macOS, Windows, WSL : [docs/INSTALLATION.md](docs/INSTALLATION.md#2-collecteurs)
- Ce qui est possible ou non, et pourquoi : [docs/LIMITATIONS.md](docs/LIMITATIONS.md)
- Architecture et protocole : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Sécurité : [docs/SECURITY.md](docs/SECURITY.md)
- Mise à jour : [docs/UPDATE.md](docs/UPDATE.md)

## Ce que le cockpit peut piloter

| Type de session | Observer | Envoyer une instruction | Interrompre / arrêter | Valider une autorisation |
|---|---|---|---|---|
| Lancée par le cockpit (Agent SDK) | ✅ | ✅ | ✅ | ✅ relais `canUseTool` |
| Interactive VS Code / terminal, hooks installés | ✅ | ✅ inbox socket | ❌ non documenté | ❌ dans son interface ou Remote Control |
| Ouverte avant l'installation des hooks | ⚠️ détection seule (registre) | ❌ | ❌ | ❌ |

## Structure

```
packages/protocol   types et schémas partagés (zod)
apps/collector      collecteur local : hooks, journal d'envoi, SDK, inbox socket
apps/server         serveur central : API, WebSocket, état, commandes, orchestrateur
apps/web            interface React + Tailwind + React Flow
scripts/            installation des collecteurs en service (launchd, tâche planifiée, systemd)
```

Node.js ≥ 22.18 requis : le TypeScript est exécuté directement par Node (suppression des types),
sans étape de compilation pour le serveur et le collecteur. SQLite est celui intégré à Node (`node:sqlite`).
