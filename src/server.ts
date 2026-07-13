import "dotenv/config";
import express from "express";
import routes from "./routes";

const app = express();

app.use(express.json());
app.use("/", routes);

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
