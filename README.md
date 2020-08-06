# mx-host-core-worker

> Generic worker code for a Matrix application host

This is designed to run in a shared or service worker in my work-in-progress
[Matrix](https://matrix.org) app host. This is the only part of that app host
that would maintain any state; The other part would be stateless except for the
URL and query parameters and will be using Vue.JS.

This is using my `rpcchannel` library that creates a standard interface for the
app host and app tabs to connect to. This is versioned using semantic
versioning, so this will be released independently of the app host code. When a
change is made, the API is tested using the `.api.js` tests (which only call
the RPC functions) and unit tests (coming soon). This allows for a much nicer
workflow where features are first implemented and then the corresponding UI
is implemented.