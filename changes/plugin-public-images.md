---
type: added
---
Plugins can show images from any public site, such as the images and sender avatars of a mail, without you opening each site in `pluginPolicy.http`: they declare the `http:public-images` permission (plugin API 20), Timon fetches only verified images and never from your local network, and `pluginPolicy.publicImages` turns it off for every plugin or for one.
