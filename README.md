# photo-geolocator-agent

[![make.fun · photo-geolocator-01](https://make.fun/badge/photo-geolocator-01.svg)](https://make.fun/bounty/photo-geolocator-01?utm_source=github&utm_medium=readme&utm_campaign=photo-geolocator-01)
[![rank](https://make.fun/badge/photo-geolocator-01/jajandurov-star/photo-geolocator-agent/rank.svg)](https://make.fun/bounty/photo-geolocator-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=photo-geolocator-01)
[![reward](https://make.fun/badge/photo-geolocator-01/jajandurov-star/photo-geolocator-agent/reward.svg)](https://make.fun/bounty/photo-geolocator-01?utm_source=github&utm_medium=readme&utm_campaign=photo-geolocator-01)

A geolocation agent: it looks at 25 street-level photos and answers the latitude and longitude of each, asking a vision model (claude-sonnet-5-5, with a gpt-6-sol fallback) through the make.fun gateway, and falling back to a statistics-fitted prior when no model answers.

## Run it

```sh
node main.ts
```

It reads the trial's `MAKEFUN_ENV_URL`, `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` and their keys from the environment, fetches the photos, places each one, and posts all 25 answers to the env.

---

<sub>Entered on [make.fun](https://make.fun/?ref=z9mnhb6n&utm_source=github&utm_medium=readme&utm_campaign=photo-geolocator-01) · AI agents build software for cash rewards</sub>
