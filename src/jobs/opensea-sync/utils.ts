import * as Sdk from "@reservoir0x/sdk";
import axios from "axios";
import pLimit from "p-limit";

import { db, pgp } from "../../common/db";
import { logger } from "../../common/logger";
import { config } from "../../config";
import { OpenSeaOrder, buildFetchOrdersURL, parseOpenSeaOrder } from "../../utils/opensea";
import { addToRelayOrdersQueue } from "../relay-orders";

export const fetchOrders = async (
  listedAfter: number,
  listedBefore: number = 0,
  backfill = false,
  once = false,
  offset = 0,
  limit = 50
) => {
  logger.info("fetch_orders", `(${listedAfter}, ${listedBefore}) Fetching orders from OpenSea`);

  let maxOrdersToFetch = 1000;
  let lastCreatedDate: string = "";

  let numOrders = 0;

  let done = false;
  while (!done) {
    const url = buildFetchOrdersURL({
      listedAfter: once ? undefined : listedAfter,
      // Break cache when fetching OpenSea's orders API without any filtering
      listedBefore: once ? Math.floor(Date.now() / 1000) : listedBefore,
      offset,
      limit,
      orderDirection: "desc",
    });

    try {
      const response = await axios.get(
        url,
        config.chainId === 1
          ? {
              headers: {
                "x-api-key": backfill ? config.backfillOpenseaApiKey : config.realtimeOpenseaApiKey,
              },
              timeout: 10000,
            }
          : // Skip including the API key on Rinkeby or else the request will fail
            { timeout: 10000 }
      );

      const orders: OpenSeaOrder[] = response.data.orders;
      const parsedOrders: Sdk.WyvernV23.Order[] = [];

      const values: any[] = [];

      const handleOrder = async (order: OpenSeaOrder) => {
        let orderTarget = order.target;

        const parsed = await parseOpenSeaOrder(order);
        if (parsed) {
          parsedOrders.push(parsed);

          const info = parsed.getInfo();
          if (info) {
            orderTarget = info.contract;
          }

          if ((parsed.params as any).nonce) {
            (order as any).nonce = (parsed.params as any).nonce;
          }
        }

        delete (order as any).asset;

        values.push({
          hash: order.prefixed_hash,
          target: orderTarget.toLowerCase(),
          maker: order.maker.address.toLowerCase(),
          created_at: new Date(order.created_date),
          data: order as any,
          delayed: !once,
          source: "opensea",
        });
      };

      const plimit = pLimit(20);
      await Promise.all(orders.map((order) => plimit(() => handleOrder(order))));

      if (parsedOrders.length) {
        await addToRelayOrdersQueue(
          parsedOrders.map((order) => ({
            kind: "wyvern-v2.3",
            data: order.params,
          })),
          true
        );
      }

      if (values.length) {
        const columns = new pgp.helpers.ColumnSet(
          ["hash", "target", "maker", "created_at", "data", "delayed", "source"],
          { table: "orders_v23" }
        );

        const result = await db.manyOrNone(
          pgp.helpers.insert(values, columns) + " ON CONFLICT DO NOTHING RETURNING 1"
        );

        if (backfill && result.length) {
          logger.warn(
            "fetch_orders",
            `OpenSea (${listedAfter}, ${listedBefore}) Backfilled ${result.length} new orders`
          );
        }
      }

      numOrders += orders.length;

      logger.info("debug", `${once ? "[LIVE]" : ""} ${orders.length} - ${url}`);

      if (once) {
        done = true;
      } else if (orders.length < limit) {
        done = true;
      } else {
        offset += limit;
      }

      // If this is real time sync, and we reached the max orders to fetch -> end the loop and new job will trigger
      if (!backfill && numOrders >= maxOrdersToFetch) {
        done = true;
      }

      if (orders.length) {
        lastCreatedDate = orders[orders.length - 1].created_date;
      }

      // Wait for one second to avoid rate-limiting
      if (!once) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      // If realtime sync return the lastCreatedDate
      if (!backfill) {
        logger.info(
          "fetch_orders",
          `(${listedAfter}, ${listedBefore}) Got ${numOrders} orders error=${error}`
        );
        return lastCreatedDate;
      }

      throw error;
    }
  }

  logger.info(
    "fetch_orders",
    `FINAL - OpenSea - (${listedAfter}, ${listedBefore}) Got ${numOrders} orders up to ${lastCreatedDate}`
  );
  return lastCreatedDate;
};