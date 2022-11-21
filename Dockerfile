FROM node:gallium-alpine

WORKDIR /relayer

COPY package.json yarn.lock ./

RUN yarn

ADD . .

RUN yarn build

CMD yarn start
