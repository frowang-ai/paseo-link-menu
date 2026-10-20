import type { PluginClientContext } from "@getpaseo/plugin/client";
import { installLinkMenu } from "./client/web";

export default function contribute(_client: PluginClientContext) {
  const removeMenu = installLinkMenu();
  return () => {
    removeMenu();
  };
}
