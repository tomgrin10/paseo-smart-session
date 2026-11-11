import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const displayPreferences = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({
    enable_composer_button: z.boolean().default(true),
    showSidebar: z.boolean().default(true),
    /** Paseo 0.16+, web and desktop: hide Paseo's own Claude usage card where Smart Session's covers the same login. */
    replaceUsageCard: z.boolean().default(true),
  }),
});

export const displayRpc = settingsRpc(displayPreferences.id);
