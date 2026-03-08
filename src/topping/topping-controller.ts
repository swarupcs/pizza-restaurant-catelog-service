import { NextFunction, Response, Request } from "express";
import { UploadedFile } from "express-fileupload";
import { v4 as uuidv4 } from "uuid";
import { FileStorage } from "../common/types/storage";
import { ToppingService } from "./topping-service";
import { CreataeRequestBody, Topping } from "./topping-types";

export class ToppingController {
    constructor(
        private storage: FileStorage,
        private toppingService: ToppingService,
    ) {}

    create = async (
        req: Request<object, object, CreataeRequestBody>,
        res: Response,
        next: NextFunction,
    ) => {
        try {
            const image = req.files!.image as UploadedFile;
            const fileUuid = uuidv4();

            // todo: add error handling
            await this.storage.upload({
                filename: fileUuid,
                fileData: image.data.buffer,
            });

            // todo: add error handling
            const savedTopping = await this.toppingService.create({
                ...req.body,
                image: fileUuid,
                tenantId: req.body.tenantId,
            } as Topping);
            // todo: add logging
            res.json({ id: savedTopping._id });
        } catch (err) {
            return next(err);
        }
    };
}
