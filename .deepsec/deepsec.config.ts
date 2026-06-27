import { defineConfig } from "deepsec/config";

export default defineConfig({
  projects: [
    { id: "CareConnecxx-main", root: ".." },
    // <deepsec:projects-insert-above>
  ],
});
