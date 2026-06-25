import { buildApp } from "./app.js";

const { app } = await buildApp({ mode: "approve" });
const created = await app.inject({
  method: "POST",
  url: "/api/incidents/demo",
  payload: { type: "post_deploy_5xx_spike", confidence: 0.94, environment: "staging" }
});
const incident = created.json();
await app.inject({ method: "POST", url: `/api/incidents/${incident.id}/plan` });
const approved = await app.inject({
  method: "POST",
  url: `/api/incidents/${incident.id}/approve`,
  payload: { actorId: "demo-operator" }
});
const replay = await app.inject({ method: "GET", url: `/api/incidents/${incident.id}/replay` });
console.log(JSON.stringify({ incident: approved.json(), audit: replay.json() }, null, 2));
await app.close();
