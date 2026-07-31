import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.mudrush.hillclimb",
  appName: "Mud Rush",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
  android: {
    backgroundColor: "#111713",
    allowMixedContent: false,
  },
};

export default config;