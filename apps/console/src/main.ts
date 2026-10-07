import { provideBrowserGlobalErrorListeners } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { App } from "./app/app.js";

bootstrapApplication(App, { providers: [provideBrowserGlobalErrorListeners()] }).catch((e: unknown) => console.error(e));
