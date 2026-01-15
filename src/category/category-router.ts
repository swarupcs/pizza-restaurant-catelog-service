import express from "express";
import { CategoryController } from "./category-controller";
import categoryValidator from "./category-validator";

const router = express.Router();

const categoryController = new CategoryController();

router.post("/", categoryValidator, categoryController.create);

export default router;
