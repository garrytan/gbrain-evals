# Memory: macOS Disk Cleanup Session (jmarcus)

## Context
User: `jmarcus` on a macOS machine with a 500GB disk.
Starting state: 467G used, 33G free (93% capacity).
Final state: approximately 120G+ free (~76% capacity after Docker prune).

## Disk Layout (at session start)
| Path | Size |
|---|---|
| `~/Library` | 142G |
| `~/Documents` | 89G |
| `~/Projects` | 76G |
| `~/Downloads` | 54G |
| `~/.cache` | 38G |
| `~/.npm` | 3.2G |
| `~/.gradle` | 2.8G |

## What Was Cleaned and How Much Was Recovered

| Item | Action | Recovered |
|---|---|---|
| `~/Library/Application Support/Nettex` | `rm -rf` (app uninstalled) | 23G |
| `~/Library/Application Support/Sparrow` | `rm -rf` (app uninstalled) | 14G |
| `~/Library/Caches/com.nettex.mailer` | `rm -rf` | 6.7G |
| `~/Library/Caches/com.sparrow.mail` | `rm -rf` | 8.4G |
| Homebrew cache | `brew cleanup --prune=all` | 3.8G |
| `node_modules` in 4 dead projects | `rm -rf` | ~13G |
| Old installers in `~/Downloads` (`.dmg`, `.pkg`, `.xip` >180 days) | `find … -delete` | 28.4G |
| Misc Downloads (zip, csv, folder) | `rm` / `rm -rf` | ~0.75G |
| Unavailable Xcode simulators | `xcrun simctl delete unavailable` | 1.4G |
| Old simulator runtimes (kept iOS 16.4 and 17.0) | Deleted via Xcode settings | 5.8G |
| pip cache | `pip cache purge` | 2.1G |
| yarn cache | `yarn cache clean` | 1.9G |
| npm cache | `npm cache clean --force` | 3.2G |
| Docker (unused images, stopped containers, volumes) | `docker system prune -a` | 22.4G |

**Total recovered: ~135G**

## Key Facts About This Machine
- Uses **Homebrew**, **pip**, **yarn**, **npm** — all caches will regrow over time.
- Active iOS development with **Xcode** (kept iOS 16.4 + 17.0 simulator runtimes).
- **Docker** installed; had 34 images, only 3 active — pruning is high-value here.
- Heavy JavaScript/Node work: `~/Projects` had 10 `node_modules` dirs totalling ~24G.
- Previously used **Nettex** and **Sparrow** as mail clients; switched to **Mailbird**.

## Remaining Large Folders Still Worth Watching
- `~/Library/Application Support/Kontainer` — 8.9G
- `~/Library/Application Support/BlueStack` — 6.2G (Android emulator disk images)
- `~/Documents` — 89G (not investigated)
- `~/.gradle` — 2.8G (not cleaned this session)

## Recurring Maintenance Advice Given
- Run quarterly: `brew cleanup --prune=all`, `pip cache purge`, `yarn cache clean`, `npm cache clean --force`
- Check `~/Projects` for stale `node_modules`: `find ~/Projects -name "node_modules" -type d -prune -mtime +90`
- Clear old Downloads installers: `find ~/Downloads -type f \( -name "*.dmg" -o -name "*.pkg" -o -name "*.xip" \) -mtime +180 -delete`
- Run `xcrun simctl delete unavailable` periodically.
- Run `docker system prune -a` periodically if Docker is active.
- Empty Trash after each major deletion batch.