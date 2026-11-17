# LEMO — Bot de surveillance des prix

Bot autonome (Node.js, zéro dépendance) qui surveille les prix des articles LEMO
chez **Carrefour** (via Bringo) et **Marjane** (via Glovo) et envoie une alerte
Telegram dans le groupe quand un prix change.

## Marques suivies (7)

Sidi Ali, Aïn Atlas, Oulmès, Bahia, Vitalya, Glass, Orangina.
Le bot lit **toutes les références** de chaque marque sur les pages catégories
(filtrage par marque, pas par nom exact) — une nouvelle taille apparaît
automatiquement. État actuel : **30 références** (Carrefour 29 + Marjane 1).

## Sources

| Source | URL | Contenu |
|---|---|---|
| Carrefour Tetouan — Eaux (Bringo) | `bringo.ma/.../carrefour-tetouan/eaux-1` | eaux, paginé (110 produits) |
| Carrefour Tetouan — Eaux & Boissons (Bringo) | `bringo.ma/.../carrefour-tetouan/eaux-boissons-11` | eaux + sodas : Glass canettes 25cl, Orangina 25cl |
| Marjane Market Tétouan (Glovo) | `glovoapp.com/.../marjane-tet99` (eaux) | **Sidi Ali 6x1,5L = 30,00 MAD seulement** — les bouteilles seules et Oulmès ne sont pas listées sur cette page |

⚠️ **Les prix varient selon le magasin** (ex. Sidi Ali 1,5L : 4,16 à Tétouan,
4,95 à Al Mazar). Le bot suit UN magasin par enseigne — les deux sont à
Tétouan (choix d'Amine, 17 nov. 2026).

Limites connues :
- Glass 1,5L / 1L bouteilles : pas trouvées sur les pages Bringo listées
  (seules les canettes 25cl sont suivies pour l'instant).
- Un prix `0,00 MAD` = rupture de stock, jamais enregistré comme prix
  (évite les fausses alertes).
- Deux références au même nom (ex. Sidi Ali 50cl à 2,80 et 9,00) : le bot
  garde la moins chère (la bouteille seule, pas le pack).

## Fonctionnement

- `check.js` : lit les pages, compare avec `prices.json`, envoie l'alerte si
  changement. Premier passage = baseline, pas d'alerte.
- `.github/workflows/daily-check.yml` : GitHub Actions, tous les jours 09:00 UTC,
  committe l'état (`prices.json`) dans le repo.
- Secrets GitHub requis : `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

## Mise en place (état 17 nov. 2026)

1. Bot Telegram : **@prixlemo_bot** — créé, vérifié (getMe OK).
2. **Chat ID du groupe** : groupe **PRX**, id `-5504871807` — message de
   test envoyé par le bot, OK.
3. Repo GitHub : `lemo-price-bot` (compte bomi3) — création + push en cours.
4. Secrets GitHub à ajouter (Settings → Secrets and variables → Actions) :
   `TELEGRAM_BOT_TOKEN` et `TELEGRAM_CHAT_ID` (`-5504871807`).
5. **Sécurité du token** : le token actuel a été envoyé dans le chat WhatsApp —
   après la mise en place, le révoquer via @BotFather (`/revoke`) et mettre
   le nouveau dans le secret GitHub (le nouveau token passe par le vault,
   jamais dans le chat).

## Test local

```bash
node check.js --dry-run   # lit les pages, ne touche ni à l'état ni à Telegram
node check.js             # vrai passage (envoie l'alerte si changement)
node check.js --full-report  # envoie la liste complète des prix une fois (sans toucher à l'état)
```

## WhatsApp (plus tard)

Pas d'API officielle gratuite pour poster dans un groupe WhatsApp.
Options quand on y sera : WhatsApp Business API (payant) ou envoi via
Neo + transfert manuel. Le code de détection de changement (`check.js`)
ne bougera pas — seul l'envoi change.
