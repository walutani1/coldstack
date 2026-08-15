/* Optional avatar photo overrides for workspace members: email → a file
   served from public/avatars. Anyone not listed shows initials. A sending
   alias keeps the person's face when its local part starts with the same
   first segment as an override key (jane.d@… matches jane@…).
   Example: "jane@yourdomain.com": "/avatars/jane.jpg" */
export const TEAM_AVATARS: Record<string, string> = {};
