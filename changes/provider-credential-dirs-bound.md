---
type: changed
---
For plugin authors: a provider plugin's manifest may now list up to 16 sign-in folders in `provider.credentialDirs` instead of 4, so a plugin that runs several agents can declare each one's folders; more than 4 needs plugin API 20, and every folder is still checked and shown on the install sheet.
