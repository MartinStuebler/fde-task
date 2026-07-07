FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# stdio MCP server: launched as a subprocess of the Duvo agent.
# NO EXPOSE / no port — this is not an HTTP service.
# --silent so npm's banner never pollutes the stdout MCP protocol stream.
CMD ["npm", "start", "--silent"]
