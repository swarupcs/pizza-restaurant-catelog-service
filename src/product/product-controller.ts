import { NextFunction, Response } from "express";
import { Request } from "express-jwt";
import { v4 as uuidv4 } from "uuid";
import { validationResult } from "express-validator";
import createHttpError from "http-errors";
import { ProductService } from "./product-service";
import { Product } from "./product-types";
import { FileStorage } from "../common/types/storage";
import { UploadedFile } from "express-fileupload";

export class ProductController {
    constructor(
        private productService: ProductService,
        private storage: FileStorage,
    ) {}

    create = async (req: Request, res: Response, next: NextFunction) => {
        const result = validationResult(req);
        if (!result.isEmpty()) {
            return next(createHttpError(400, result.array()[0].msg as string));
        }

        const image = req.files!.image as UploadedFile;
        const imageName = uuidv4();

        await this.storage.upload({
            filename: imageName,
            fileData: image.data.buffer,
        });

        const {
            name,
            description,
            priceConfiguration,
            attributes,
            tenantId,
            categoryId,
            isPublish,
        } = req.body;

        const product = {
            name,
            description,
            priceConfiguration: JSON.parse(priceConfiguration as string),
            attributes: JSON.parse(attributes as string),
            tenantId,
            categoryId,
            isPublish,
            image: imageName,
        };

        const newProduct = await this.productService.createProduct(
            product as unknown as Product,
        );

        res.json({ id: newProduct._id });
    };
}
