# Contributing

Thanks for looking! Ideas, bug reports and pull requests are welcome.

1. Fork the repository and make a branch.
2. `npm start` once (it sets everything up), then change code. The web client has hot reload: `npm run dev:client`.
3. Before you open a pull request, run `npm run check` (every JavaScript file must parse) and `npm run build`.
4. Keep secrets out: never commit `.env`, `livekit.yaml`, `data/`, or any `.exe` / `.dll`.
5. Describe what you changed and how you tried it.

Larger ideas (a phone app, more game-controller layouts, translations) are best discussed in an issue first.
