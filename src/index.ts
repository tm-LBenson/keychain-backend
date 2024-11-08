import express, { Request, Response } from "express";
import admin from "firebase-admin";
import "dotenv/config";
import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  LogLevel,
  OrdersController,
} from "@paypal/paypal-server-sdk";
import bodyParser from "body-parser";
import cors from "cors";

const app = express();
app.use(bodyParser.json());
app.use(cors());

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PORT = 3000 } = process.env;

const client = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: PAYPAL_CLIENT_ID || "",
    oAuthClientSecret: PAYPAL_CLIENT_SECRET || "",
  },
  timeout: 0,
  environment: Environment.Sandbox,
  logging: {
    logLevel: LogLevel.Info,
    logRequest: { logBody: true },
    logResponse: { logHeaders: true },
  },
});

const ordersController = new OrdersController(client);
export interface UnitAmount {
  currencyCode: string;
  value: string;
}
interface Item {
  id: string;
  name: string;
  description: string;
  imageUrls: string[];
  unitAmount: UnitAmount;
  quantity: number;
  originalPrice?: string;
}

interface OrderResponse {
  jsonResponse: any;
  httpStatusCode: number;
}

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.PROJECT_ID,
    clientEmail: process.env.CLIENT_EMAIL,
    privateKey: process.env.PRIVATE_KEY?.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

const fetchProductDetails = async (productId: string) => {
  try {
    const docRef = db.collection("products").doc(productId);
    const docSnap = await docRef.get();

    if (docSnap.exists) {
      return docSnap.data();
    } else {
      console.log("No such document!");
      return null;
    }
  } catch (error) {
    console.error("Failed to fetch product details:", error);
    throw error;
  }
};

/**
 * Create an order to start the transaction.
 */

const createOrder = async (cart: Item[]): Promise<OrderResponse> => {
  const purchaseUnits = await Promise.all(
    cart.map(async (item) => {
      const itemDetails = await fetchProductDetails(item.id);
      return {
        amount: {
          currencyCode: itemDetails?.unitAmount.currencyCode,
          value: itemDetails?.unitAmount.value,
        },
      };
    }),
  );

  const orderRequest = {
    intent: CheckoutPaymentIntent.Capture,
    purchaseUnits: purchaseUnits,
  };

  try {
    const collect = {
      body: orderRequest,
    };

    const { body, ...httpResponse } = await ordersController.ordersCreate(
      collect,
    );

    return {
      jsonResponse: body,
      httpStatusCode: httpResponse.statusCode,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      console.log(error.body);
      throw new Error(`PayPal API error: ${error.message}`);
    }

    throw error;
  }
};

app.get("/", (req, res) => {
  res.send({ message: "Server online" });
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const product = await fetchProductDetails(id);
    if (product) {
      res.status(200).json(product);
    } else {
      res.status(404).send("Product not found");
    }
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: error });
  }
});

// Create order route
app.post("/api/orders", async (req: Request, res: Response) => {
  try {
    const cart: Item[] = req.body.cart;
    const { jsonResponse, httpStatusCode } = await createOrder(cart);
    console.log("LAST", jsonResponse, httpStatusCode);
    res.status(httpStatusCode).json(jsonResponse);
  } catch (error) {
    console.error("Failed to create order:", error);
    res.status(500).json({ error: "Failed to create order." });
  }
});

/**
 * Capture payment for the created order to complete the transaction.
 */
const captureOrder = async (orderID: string): Promise<OrderResponse> => {
  try {
    const response = await ordersController.ordersCapture({
      id: orderID,
    });

    return {
      jsonResponse: response.result,
      httpStatusCode: response.statusCode,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      console.log(error.body);
      throw new Error(`PayPal API error: ${error.message}`);
    }
    throw error;
  }
};

app.post(
  "/api/orders/:orderID/capture",
  async (req: Request, res: Response) => {
    try {
      const orderID: string = req.params.orderID;
      const { jsonResponse, httpStatusCode } = await captureOrder(orderID);
      res.status(httpStatusCode).json(jsonResponse);
    } catch (error) {
      console.error("Failed to capture order:", error);
      res.status(500).json({ error: "Failed to capture order." });
    }
  },
);

app.listen(PORT, () => {
  console.log(`Node server listening at http://localhost:${PORT}/`);
});
