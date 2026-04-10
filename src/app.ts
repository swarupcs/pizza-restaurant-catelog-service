import express, { Request, Response } from "express";
import config from "config";
import cors from "cors";

import cookieParser from "cookie-parser";
import { globalErrorHandler } from "./common/middlewares/globalErrorHandler";
import categoryRouter from "./category/category-router";
import productRouter from "./product/product-router";
import toppingRouter from "./topping/topping-router";

const app = express();
const ALLOWED_DOMAINS = [
    config.get("frontend.clientUI"),
    config.get("frontend.adminUI"),
];

app.use(
    cors({
        origin: ALLOWED_DOMAINS as string[],
    }),
);

app.use(express.json());
app.use(cookieParser());

app.get("/", (req: Request, res: Response) => {
    res.json({ message: "Hello from catalog service!" });
});

app.use("/categories", categoryRouter);
app.use("/products", productRouter);
app.use("/toppings", toppingRouter);

app.use(globalErrorHandler);

export default app;
