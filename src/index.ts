#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fetch from 'node-fetch';
import * as http from 'http';
import * as express from 'express';
import * as cors from 'cors';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Type definitions
interface Movie {
  id: number;
  title: string;
  release_date: string;
  vote_average: number;
  overview: string;
  poster_path?: string;
  genres?: Array<{ id: number; name: string }>;
}

interface TMDBResponse {
  page: number;
  results: Movie[];
  total_pages: number;
}

interface MovieDetails extends Movie {
  credits?: {
    cast: Array<{
      name: string;
      character: string;
    }>;
    crew: Array<{
      name: string;
      job: string;
    }>;
  };
  reviews?: {
    results: Array<{
      author: string;
      content: string;
      rating?: number;
    }>;
  };
}

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = "https://api.themoviedb.org/3";

// Create the MCP server
const server = new Server(
  {
    name: "example-servers/tmdb",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

async function fetchFromTMDB<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${TMDB_BASE_URL}${endpoint}`);
  url.searchParams.append("api_key", TMDB_API_KEY!);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.append(key, value);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`TMDB API error: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function getMovieDetails(movieId: string): Promise<MovieDetails> {
  return fetchFromTMDB<MovieDetails>(`/movie/${movieId}`, { append_to_response: "credits,reviews" });
}

server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
  const params: Record<string, string> = {
    page: request.params?.cursor || "1",
  };

  const data = await fetchFromTMDB<TMDBResponse>("/movie/popular", params);
  
  return {
    resources: data.results.map((movie) => ({
      uri: `tmdb:///movie/${movie.id}`,
      mimeType: "application/json",
      name: `${movie.title} (${movie.release_date.split("-")[0]})`,
    })),
    nextCursor: data.page < data.total_pages ? String(data.page + 1) : undefined,
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const movieId = request.params.uri.replace("tmdb:///movie/", "");
  const movie = await getMovieDetails(movieId);

  const movieInfo = {
    title: movie.title,
    releaseDate: movie.release_date,
    rating: movie.vote_average,
    overview: movie.overview,
    genres: movie.genres?.map(g => g.name).join(", "),
    posterUrl: movie.poster_path ?
      `https://image.tmdb.org/t/p/w500${movie.poster_path}` :
      "No poster available",
    cast: movie.credits?.cast?.slice(0, 5).map(actor => `${actor.name} as ${actor.character}`),
    director: movie.credits?.crew?.find(person => person.job === "Director")?.name,
    reviews: movie.reviews?.results?.slice(0, 3).map(review => ({
      author: review.author,
      content: review.content,
      rating: review.rating
    }))
  };

  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify(movieInfo, null, 2),
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_movies",
        description: "Search for movies by title or keywords",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query for movie titles",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_recommendations",
        description: "Get movie recommendations based on a movie ID",
        inputSchema: {
          type: "object",
          properties: {
            movieId: {
              type: "string",
              description: "TMDB movie ID to get recommendations for",
            },
          },
          required: ["movieId"],
        },
      },
      {
        name: "get_trending",
        description: "Get trending movies for a time window",
        inputSchema: {
          type: "object",
          properties: {
            timeWindow: {
              type: "string",
              enum: ["day", "week"],
              description: "Time window for trending movies",
            },
          },
          required: ["timeWindow"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case "search_movies": {
        const query = request.params.arguments?.query as string;
        const data = await fetchFromTMDB<TMDBResponse>("/search/movie", { query });
        
        const results = data.results
          .map((movie) =>
            `${movie.title} (${movie.release_date?.split("-")[0]}) - ID: ${movie.id}\n` +
            `Rating: ${movie.vote_average}/10\n` +
            `Overview: ${movie.overview}\n`
          )
          .join("\n---\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${data.results.length} movies:\n\n${results}`,
            },
          ],
          isError: false,
        };
      }

      case "get_recommendations": {
        const movieId = request.params.arguments?.movieId as string;
        const data = await fetchFromTMDB<TMDBResponse>(`/movie/${movieId}/recommendations`);
        
        const recommendations = data.results
          .slice(0, 5)
          .map((movie) =>
            `${movie.title} (${movie.release_date?.split("-")[0]})\n` +
            `Rating: ${movie.vote_average}/10\n` +
            `Overview: ${movie.overview}\n`
          )
          .join("\n---\n");

        return {
          content: [
            {
              type: "text",
              text: `Top 5 recommendations:\n\n${recommendations}`,
            },
          ],
          isError: false,
        };
      }

      case "get_trending": {
        const timeWindow = request.params.arguments?.timeWindow as string;
        const data = await fetchFromTMDB<TMDBResponse>(`/trending/movie/${timeWindow}`);
        
        const trending = data.results
          .slice(0, 10)
          .map((movie) =>
            `${movie.title} (${movie.release_date?.split("-")[0]})\n` +
            `Rating: ${movie.vote_average}/10\n` +
            `Overview: ${movie.overview}\n`
          )
          .join("\n---\n");

        return {
          content: [
            {
              type: "text",
              text: `Trending movies for the ${timeWindow}:\n\n${trending}`,
            },
          ],
          isError: false,
        };
      }

      default:
        throw new Error("Tool not found");
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
if (!TMDB_API_KEY) {
  console.error("TMDB_API_KEY environment variable is required");
  process.exit(1);
}

// Create Express app for SSE endpoint
const app = express();
app.use(cors());

// For tracking SSE clients
const clients = new Map();
let clientId = 0;

// SSE endpoint
app.get('/sse', (req, res) => {
  const id = clientId++;
  
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  
  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: "connected", client: id })}\n\n`);
  
  // Create a custom transport for this SSE client
  const sseTransport = {
    sendMessage: (message: string) => {
      res.write(`data: ${message}\n\n`);
    },
    onMessage: (handler: (message: string) => void) => {
      clients.set(id, handler);
      return () => clients.delete(id);
    },
    close: () => {
      clients.delete(id);
      res.end();
    }
  };
  
  // Handle incoming MCP messages from the client
  req.on('data', (chunk) => {
    const message = chunk.toString();
    if (clients.has(id)) {
      const handler = clients.get(id);
      try {
        handler(message);
      } catch (error) {
        console.error('Error handling message:', error);
      }
    }
  });
  
  // Handle client disconnect
  req.on('close', () => {
    console.log(`SSE client ${id} disconnected`);
    clients.delete(id);
  });
  
  // Create and connect a new MCP server instance for this connection
  const sseServer = new Server(
    {
      name: "example-servers/tmdb",
      version: "0.1.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );
  
  // Re-use the same request handlers
  sseServer.setRequestHandler(ListResourcesRequestSchema, server.getRequestHandler(ListResourcesRequestSchema));
  sseServer.setRequestHandler(ReadResourceRequestSchema, server.getRequestHandler(ReadResourceRequestSchema));
  sseServer.setRequestHandler(ListToolsRequestSchema, server.getRequestHandler(ListToolsRequestSchema));
  sseServer.setRequestHandler(CallToolRequestSchema, server.getRequestHandler(CallToolRequestSchema));
  
  // Connect the server to the SSE transport
  sseServer.connect(sseTransport).catch((error) => {
    console.error("SSE server connection error:", error);
    res.end();
  });
});

// Add a route for regular HTTP requests
app.get('/', (req, res) => {
  res.send('TMDB MCP Server is running. Use the /sse endpoint for MCP communication.');
});

// Add a status endpoint
app.get('/status', (req, res) => {
  res.json({
    status: 'running',
    server_name: 'mcp-server-tmdb',
    version: '0.1.0',
    endpoints: ['/', '/status', '/sse'],
    features: ['HTTP', 'SSE', 'MCP']
  });
});

// Start the Express server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`MCP Server with SSE support running on port ${port}`);
});

// Also start the traditional stdio transport for local usage
const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error("Local server connection error:", error);
  process.exit(1);
});
