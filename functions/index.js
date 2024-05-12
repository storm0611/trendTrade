import functions from "firebase-functions";
import OpenAI from "openai";
import backoff from "backoff";
import fetch from "node-fetch";

import { configInstructions } from "./config.js";

const openai = new OpenAI({
  apiKey: functions.config().open_ai_dev.api_key,
});
const alphaVApiKey = functions.config().alpha_vantage_dev.api_key;

export const echoText = functions.https.onRequest((request, response) => {
  const exponentialBackoff = backoff.exponential({
    initialDelay: 1000, // 1 second
    maxDelay: 10000, // 10 seconds
  });

  exponentialBackoff.on("backoff", function (number, delay) {
    console.log(`Retrying request (attempt #${number}) in ${delay}ms...`);
  });

  if (request.method !== "POST") {
    response.status(405).send("Method Not Allowed");
    return;
  }

  const { inputText } = request.body;

  if (!inputText) {
    response.status(400).send("Missing input text");
    return;
  }

  exponentialBackoff.on("ready", async function () {
    try {
      const chatCompletion = await openai.chat.completions.create({
        messages: [
          {
            role: "user",
            content: `${inputText} ${configInstructions}`,
          },
        ],
        model: "gpt-3.5-turbo",
      });

      let data;
      try {
        data = JSON.parse(chatCompletion.choices[0].message.content);
      } catch (jsonError) {
        console.error("Error parsing OpenAI response:", jsonError);
        response.status(500).send("Error parsing OpenAI response");
        return;
      }

      if (data === null) {
        response.status(400).send("Null");
      }

      const tickerData = data.predictions.map(
        (prediction) => prediction.Ticker
      );

      const latestValues = await Promise.all(
        tickerData.map(async (symbol) => {
          const alphaVApiUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${alphaVApiKey}`;
          try {
            const res = await fetch(alphaVApiUrl);
            const dataValue = await res.json();
            if (dataValue["Time Series (Daily)"]) {
              const latestData = dataValue["Time Series (Daily)"];
              const latestDate = Object.keys(latestData)[0];
              const beforeOnedate = Object.keys(latestData)[1];
              const latestCloseValue = latestData[latestDate]["4. close"];
              const beforeOnedayCloseValue =
                latestData[beforeOnedate]["4. close"];
              let currentTrend = parseFloat(
                ((latestCloseValue - beforeOnedayCloseValue) /
                  beforeOnedayCloseValue) *
                  100
              ).toFixed(2);
              if (currentTrend > 0) {
                currentTrend = `+${currentTrend}`;
              }
              const prediction = data.predictions.find(
                (p) => p.Ticker === symbol
              );
              return {
                "Company/ETF Name": prediction["Company/ETF Name"],
                Ticker: symbol,
                "Current Price": latestCloseValue,
                "Current Trend": currentTrend,
                Impact: prediction.Impact,
                Why: prediction.Why,
              };
            } else {
              console.error(`No data available for symbol: ${symbol}`);
              return null;
            }
          } catch (error) {
            console.error("error fetching API data: ", error);
            return null;
          }
        })
      );

      const predictionResult = latestValues.filter((v) => v !== null);

      response.status(200).send(predictionResult);
      if (latestValues === null) {
        response.status(400).send("Null");
      }
    } catch (error) {
      if (error.response && error.response.status === 429) {
        console.error("Rate limit exceeded. Retrying after delay...");
        exponentialBackoff.backoff();
      } else {
        console.error("Unexpected error:", error);
      }
    }
  });

  exponentialBackoff.backoff();
});
