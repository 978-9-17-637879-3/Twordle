const express = require("express");
const app = express();
const path = require("path");

const server = require("http").createServer(app);

const {MongoClient} = require("mongodb");
const mongoClient = new MongoClient("mongodb://127.0.0.1:27017");
let gamesCollection;
let archiveCollection;
let usersCollection;

const DEBUG_VALIDATION_LOGGING = false;

const {v4: uuidv4} = require("uuid");
const {answerbank} = require("./static/js/words.require");

app.use(express.static("static"));

async function generateGameID() {
    let gameId = uuidv4().split("-")[0];
    while (
        (await gamesCollection.findOne({gameId})) ||
        (await gamesCollection.findOne({rematchGameId: gameId}))
        ) {
        gameId = uuidv4().split("-")[0];
    }
    return gameId;
}

async function createGame(isRandom, suppliedGameId) {
    const idStartTime = Date.now();
    const gameId = suppliedGameId ?? (await generateGameID());
    const rematchGameId = await generateGameID();
    console.log(
        `took ${Date.now() - idStartTime}ms to generate gameIds`,
        gameId,
        rematchGameId
    );
    await gamesCollection.insertOne({
        gameId,
        rematchGameId,
        creationDate: Date.now(),
        word: answerbank[Math.floor(Math.random() * answerbank.length)],
        sockets: [],
        guesses: {},
        started: false,
        over: false,
        rematchStarted: false,
        isRandom,
        creationTimestamp: Date.now(),
    });
    return gameId;
}

app.post("/create", async (req, res) => {
    const gameId = await createGame(false);
    res.redirect("/game?id=" + gameId);
});

app.post("/randomGame", async (req, res) => {
    const game = (
        await gamesCollection
            .find({isRandom: true, over: false, sockets: {$size: 1}})
            .sort({creationTimestamp: 1})
            .limit(1)
            .toArray()
    )?.[0];
    if (game) {
        res.redirect("/game?id=" + game.gameId);
    } else {
        const newGameId = await createGame(true);
        res.redirect("/game?id=" + newGameId);
    }
});

const indexHTML = require("fs").readFileSync("./index.html").toString();
app.get("/", async (req, res) => {
    const privatePlayerCount = (await gamesCollection.count({
            isRandom: false,
            over: false,
            sockets: {$size: 1},
        })) +
        (await gamesCollection.count({
            isRandom: false,
            over: false,
            sockets: {$size: 2},
        })) *
        2;

    const quickGamePlayerCount = (await gamesCollection.count({
            isRandom: true,
            over: false,
            sockets: {$size: 1},
        })) +
        (await gamesCollection.count({
            isRandom: true,
            over: false,
            sockets: {$size: 2},
        })) *
        2

    const totalPlayerCount = privatePlayerCount + quickGamePlayerCount
    res.send(
        require("fs").readFileSync("./index.html").toString()
            .replace(
                "{{PRIVATEPLAYERCOUNT}}",
                privatePlayerCount
            )
            .replace(
                "{{QUICKGAMEPLAYERCOUNT}}",
                quickGamePlayerCount
            )
            .replace(
                "{{TOTALPLAYERCOUNT}}",
                totalPlayerCount
            )
    );
});

app.get("/game", (req, res) => {
    res.sendFile(path.join(__dirname, "./game.html"));
});


const io = require("socket.io")(server, {});

const GAME_ID_REGEX = /^[0-9a-f]{8}$/;
const GUESS_REGEX = /^\w{5}$/;

function other(self, game) {
    return game?.sockets[0] === self ? game?.sockets[1] : game?.sockets[0];
}

function countCharInString(charToTest, stringToSearch) {
    let count = 0;
    for (const c of stringToSearch.split("")) {
        if (c === charToTest) count++;
    }
    return count;
}

const asyncWaitMS = (time) =>
    new Promise((resolve) => setTimeout(resolve, time));

io.on("connection", (socket) => {
    socket.once("register", async (gameId) => {
        console.log(`registering ${socket.id} for game ${gameId}`);
        if (!GAME_ID_REGEX.test(gameId)) {
            socket.emit("registerReply", 400);
            return socket.disconnect();
        }
        const game = await gamesCollection.findOne({gameId});
        if (game === null) {
            socket.emit("registerReply", 404);
            return socket.disconnect();
        }
        if (game.sockets.length >= 2) {
            socket.emit("registerReply", 403);
            return socket.disconnect();
        }
        const shouldStart = game.sockets.length === 1;
        const setQuery = {};
        setQuery[`guesses.${socket.id}`] = [];
        await gamesCollection.updateOne(
            {gameId},
            {
                $push: {sockets: socket.id},
                $set: setQuery,
                // $set: { started: game.sockets.length === 1 },
            }
        );
        socket.emit("registerReply", 200);
        if (!shouldStart) return;
        await asyncWaitMS(500);
        let changeGame = await gamesCollection.findOne({gameId});
        for (let i = 3; i > 0; i--) {
            if (!changeGame) return;
            io.to(changeGame.sockets[0]).emit("countdown", `${i}...`);
            io.to(changeGame.sockets[1]).emit("countdown", `${i}...`);
            changeGame = await gamesCollection.findOne({gameId});
            await asyncWaitMS(1000);
        }
        await gamesCollection.updateOne(
            {gameId},
            {$set: {started: shouldStart}}
        );
        io.to(changeGame.sockets[0]).emit("countdown", "");
        io.to(changeGame.sockets[1]).emit("countdown", "");
    });

    socket.on("guess", async (data) => {
        const guessStart = Date.now();
        const {guess, gameId} = data;
        const game = await gamesCollection.findOne({gameId});
        if (
            game === null ||
            !game.sockets.includes(socket.id) ||
            !GUESS_REGEX.test(guess) ||
            game.guesses[socket.id].length === 6
        ) {
            console.log("Cheater detected!");
            socket.disconnect();
            return;
        }
        if (!game.started) {
            console.log("game not started");
            socket.emit("guessValidate", {invalid: true, reason: 'notStarted'});
            return;
        }
        if (game.guesses[socket.id].find(previousGuesses => previousGuesses.guess === guess.toLowerCase())) {
            console.log("dup guess")
            socket.emit("guessValidate", {invalid: true, reason: 'duplicate'})
            return;
        }
        console.log(`Guess is ${guess}, word is ${game.word}`);
        const pushQuery = {};
        pushQuery[`guesses.${socket.id}`] = {guess, guessStart};
        await gamesCollection.updateOne(
            {gameId},
            {
                $push: pushQuery,
            }
        );

        let isWin = true;
        const guessArray = [];
        const regLets = [];
        // pass green
        for (let i = 0; i < guess.length; i++) {
            if (guess[i] === game.word.charAt(i)) {
                guessArray[i] = {color: "green", letter: guess[i]};
                regLets.push(guess[i]);
            }
        }
        // pass orange
        for (let i = 0; i < guess.length; i++) {
            const char = game.word.charAt(i);
            if (
                !guessArray[i] &&
                guess[i] !== char &&
                game.word.includes(guess[i]) &&
                countCharInString(guess[i], game.word) >
                regLets.filter((letter) => letter === guess[i]).length
            ) {
                guessArray[i] = {color: "yellow", letter: guess[i]};
                regLets.push(guess[i]);
                isWin = false;
            }
        }
        // pass grey
        for (let i = 0; i < guess.length; i++) {
            if (!guessArray[i]) {
                guessArray[i] = {color: "grey", letter: guess[i]};
                isWin = false;
            }
        }
        if (DEBUG_VALIDATION_LOGGING) console.log("final validation:", guessArray, isWin);

        if (isWin) {
            await gamesCollection.updateOne(
                {gameId},
                {
                    $set: {over: true},
                }
            );
        } else if (
            game.guesses[socket.id].length === 5 &&
            game.guesses[other(socket.id, game)].length === 6
        ) {
            await gamesCollection.updateOne(
                {gameId},
                {
                    $set: {over: true},
                }
            );
            if (
                !Object.values(game.guesses)
                    .flat()
                    .map((guessEntry) => guessEntry.guess)
                    .includes(game.word)
            ) {
                socket.emit("wordSend", game.word);
                io.to(other(socket.id, game))?.emit("wordSend", game.word);
            }
        }
        await socket.emit("guessValidate", {
            guessArray: guessArray.map((guess) => guess.color),
            isWin,
        });
        io.to(other(socket.id, game)).emit("opponentGuess", {
            guessArray: guessArray.map((guess) => guess.color),
            isWin,
        });
        console.log(`Took ${Date.now() - guessStart}ms to validate guess`);
    });

    socket.on("gameOver", async (data) => {
        const {gameId} = data;
        const game = await gamesCollection.findOne({gameId});
        io.to(other(socket.id, game))?.emit("gameOver", data);
    });

    socket.once("rematchRequest", async (gameId) => {
        const game = await gamesCollection.findOne({gameId});
        if (game === null || !game.sockets.includes(socket.id) || !game.over) {
            console.log("Early rematcher detected!");
            socket.disconnect();
            return;
        }
        if (game.rematchStarted) {
            socket.emit("rematchReply", game.rematchGameId);
        } else {
            await gamesCollection.updateOne(
                {gameId},
                {$set: {rematchStarted: true}}
            );
            await createGame(false, game.rematchGameId);
            socket.emit("rematchReply", game.rematchGameId);
        }
    });

    socket.on("disconnect", async () => {
        const game = (
            await gamesCollection.findOneAndUpdate(
                {sockets: socket.id},
                {$pull: {sockets: socket.id}},
                {returnDocument: "after"}
            )
        ).value;
        console.log(game);
        if (!game) return;
        if (game.over) {
            console.log("waiting to delete over game");
            await new Promise((resolve) => setTimeout(resolve, 180000));
            console.log("attempting to delete game, checking");
            if (await gamesCollection.findOne({gameId: game.gameId})) {
                console.log("archiving");

                await gamesCollection.deleteOne({gameId: game.gameId});
                await archiveCollection.insertOne(game);
            }
            return;
        }
        if (game.sockets.length === 0) {
            await gamesCollection.deleteOne({gameId: game.gameId});
        } else if (game.started) {
            console.log("Early quit...");
            const otherSocket = io.to(other(socket.id, game));
            if (otherSocket) {
                try {
                    otherSocket.emit("gameOver", {guessArray: []});
                    otherSocket.disconnect();
                } catch (e) {
                }
            }
            await gamesCollection.deleteOne({gameId: game.gameId});
        }
    });
});

mongoClient.connect().then(() => {
    gamesCollection = mongoClient.db("twordle").collection("games");
    archiveCollection = mongoClient.db("twordle").collection("archive");
    usersCollection = mongoClient.db("twordle").collection("users");
    server.listen(3500, () => console.log("ready at", Date.now()));
});
