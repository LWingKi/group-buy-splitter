# Group Buy Splitter

Work out how much everyone owes in a group buy. People sign in with their Discord name (no password).

## Run it

Requires Node 18 or newer. There are no dependencies to install.

```bash
npm start
```

Then open http://localhost:3000. Set `PORT` to use another port and `DATA_FILE` to choose where data is saved (default: `data.json` next to `server.js`).

## Who can do what

| Action | Organiser | Person who joined |
|---|---|---|
| Add items | ✅ | ✅ (price stays "TBC") |
| Rename items | ✅ | ✅ |
| Set or change item prices | ✅ | ❌ |
| Remove items | ✅ | ❌ |
| Add people | ✅ | ✅ |
| Remove people | ✅ anyone | Only themselves (leave) |
| Change quantities | ✅ anyone's | Only their own row |
| Set shipping and how it's split | ✅ | ✅ |
| See all totals | ✅ | ✅ |
| Rename / delete the group buy | ✅ | ❌ |

## How totals are worked out

- Per person: their items (quantity × price) plus their share of shipping.
- Per item: total quantity ordered × price.
- Whole order: all items plus shipping.
- Shipping can be split by item cost (default), by number of items, or equally between people who ordered something. Shares are rounded to the cent so they always add up to the exact shipping amount.
- Items without a price yet are left out of the totals until the organiser sets one.

## Note on security

There are no passwords, by design, so anyone who types someone else's Discord name can act as them. That's fine for a trusted Discord server, but don't use it for anything sensitive.

## Deploying

Any host that runs Node works (Render, Railway, Fly.io, a VPS). Make sure `DATA_FILE` points to persistent storage, since some hosts wipe the disk on every deploy.
