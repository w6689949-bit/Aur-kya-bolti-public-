import express, { type Express } from "express";
import router from "./routes/index.js";

const app: Express = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));
app.use("/api", router);

export default app;
