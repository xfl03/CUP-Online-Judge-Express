const query = require("./mysql_query");
const cache_query = require("./mysql_cache");
const const_variable = require("./const_name");
const dayjs = require("dayjs");
const NORMAL_SUBMISSION = 1;
const CONTEST_SUBMISSION = 2;
const TOPIC_SUBMISSION = 3;
const NOTEXIST = 0;
const PUBLIC = 1;
const PRIVATE = 2;
const LANGMASK = const_variable.langmask;

function deepCopy(obj) {
	return JSON.parse(JSON.stringify(obj));
}

async function problemInFutureOrCurrentContest(problem_id) {
	const data = await cache_query(`select contest_id,start_time,end_time from contest where
contest_id in (select contest_id from contest_problem where problem_id = ?)
and end_time > NOW()`, [problem_id]);
	return (data && data.length > 0);
}

async function contestIsStart(contest_id) {
	const data = await cache_query("select start_time,end_time from contest where contest_id = ?", [contest_id]);
	const start_time = dayjs(data[0].start_time);
	const end_time = dayjs(data[0].end_time);
	const now = dayjs();
	return now.isAfter(start_time) && now.isBefore(end_time);
}

async function getLangmaskForContest(contest_id) {
	const data = await cache_query(`select langmask from contest 
    where contest_id = ?`, [contest_id]);
	return data[0].langmask;
}

async function getLangmaskForTopic(topic_id) {
	const data = await cache_query(`select langmask fron special_subject 
    where topic_id = ?`, [topic_id]);
	return data[0].langmask;
}

async function checkContestPrivilege(req, contest_id) {
	if (req.session.isadmin || req.session.contest[`c${contest_id}`] || req.session.contest_maker[`c${contest_id}`] || req.session.contest_manager) {
		return true;
	}
	const data = await cache_query("select private,defunct from contest where contest_id = ?", [contest_id]);
	const _private = parseInt(data[0].private) === 1;
	const defunct = data[0].defunct === "Y";
	if (defunct) {
		return false;
	}
	return !_private;
}

async function checkTopicPrivilege(req, topic_id) {
	if (req.session.isadmin) {
		return true;
	}
	const data = await cache_query("select private,defunct from special_subject where topic_id = ?", [topic_id]);
	const _private = parseInt(data[0].private) === 1;
	const defunct = data[0].defunct === "Y";
	if (defunct) {
		return false;
	}
	return !_private;
}

async function contestIncludeProblem(contest_id, num) {
	const data = await cache_query(`select problem_id from contest_problem
     where contest_id = ? and num = ?`, [contest_id, num]);
	if (!data || data.length === 0) {
		return false;
	} else {
		return parseInt(data[0].problem_id);
	}
}

async function TopicIncludeProblem(topic_id, num) {
	const data = await cache_query(`select problem_id from contest_problem
     where topic_id = ? and num = ?`, [topic_id, num]);
	if (!data || data.length === 0) {
		return false;
	} else {
		return parseInt(data[0].problem_id);
	}
}

async function problemPublic(problem_id) {
	const data = await cache_query("select defunct from problem where problem_id = ?", [problem_id]);
	if (!data || data.length === 0) {
		return NOTEXIST;
	} else {
		return data[0].defunct === "N" ? PUBLIC : PRIVATE;
	}
}

async function makePrependAndAppendCode(problem_id, source, language) {
	const data = await cache_query("select * from prefile where problem_id = ? and type = ?", [problem_id, language]);

	let new_source = deepCopy(source);

	if (data.length === 0) {
		return new_source;
	}

	for (let i of data) {
		if (parseInt(i.prepend) === 1) {
			new_source = i.code + "\n" + new_source;
		} else {
			new_source += "\n" + i.code;
		}
	}
	return new_source;
}

function checkLangmask(language, langmask = LANGMASK) {
	return Boolean((~langmask) & (1 << language));
}

function getIP(req) {
	return (req.headers["x-forwarded-for"] || req.connection.remoteAddress).split(",")[0];
}


module.exports = async function (req, data) {
	let submission_type = 0;
	if (data.type === "problem") {
		submission_type = NORMAL_SUBMISSION;
	} else if (data.type === "contest") {
		submission_type = CONTEST_SUBMISSION;
	} else if (data.type === "topic") {
		submission_type = TOPIC_SUBMISSION;
	}
	if (submission_type === 0) {
		return {
			status: "error",
			statement: "submission type is not valid"
		};
	}

	if (submission_type === NORMAL_SUBMISSION) {
		const originalProblemId = parseInt(data.id);
		const language = parseInt(data.language);
		if (isNaN(originalProblemId)) {
			return {
				status: "error",
				statement: "Problem ID is not valid"
			};
		}
		const positiveProblemId = Math.abs(originalProblemId);
		if (!checkLangmask(language)) {
			return {
				status: "error",
				statement: "Your language is not valid"
			};
		}
		const problemPublicStatus = await problemPublic(positiveProblemId);
		switch (problemPublicStatus) {
		case NOTEXIST:
			return {
				status: "error",
				statement: "problem is not exist"
			};
		case PUBLIC:
			break;
		case PRIVATE:
			if (req.session.isadmin || req.session.editor || req.session.problem_maker[`p${positiveProblemId}`]) {
				break;
			} else {
				return {
					status: "error",
					statement: "You don't have privilege to access this problem"
				};
			}
		}
		if (await problemInFutureOrCurrentContest(positiveProblemId)) {
			return {
				status: "error",
				statement: "problem is in current or future contest."
			};
		}

		const source_code = await makePrependAndAppendCode(positiveProblemId, data.source, language);
		const source_code_user = deepCopy(data.source);
		const IP = getIP(req);
		const judger = "待分配";
		const fingerprint = data.fingerprint;
		const code_length = source_code_user.length;
		const share = Boolean(data.share);
		const result = await query(`insert into solution(problem_id,user_id,in_date,language,ip,code_length,share,judger,fingerprint)
		values(?,?,NOW(),?,?,?,?,?,?)`, [originalProblemId, req.session.user_id, language, IP, code_length, share, judger, fingerprint]);
		const solution_id = result.insertId;
		let promiseArray = [query(`insert into source_code_user(solution_id,source)
		values(?,?)`, [solution_id, source_code_user]),
		query(`insert into source_code(solution_id, source)
		values(?,?)`, [solution_id, source_code])
		];
		if (originalProblemId !== positiveProblemId) {
			promiseArray.push(query(`insert into custominput(solution_id, input_text)
            values(?,?)`, [solution_id, data.input_text]));
		}
		await Promise.all(promiseArray);
		return {
			status: "OK",
			solution_id
		};
	} else if (submission_type === CONTEST_SUBMISSION) {
		const originalContestID = parseInt(data.cid);
		const language = parseInt(data.language);
		const originalPID = parseInt(data.pid);
		if (isNaN(originalContestID) || isNaN(originalPID)) {
			return {
				status: "error",
				statement: "Invalid contest_id or pid"
			};
		}
		const positiveContestID = Math.abs(originalContestID);
		let problem_id = await contestIncludeProblem(positiveContestID, originalPID);
		if (problem_id === false) {
			return {
				status: "error",
				statement: "problem is not in contest"
			};
		}
		if (!await checkContestPrivilege(req, positiveContestID)) {
			return {
				status: "error",
				statement: "You don't have privilege to access this contest problem"
			};
		}
		if (!await contestIsStart(positiveContestID)) {
			return {
				status: "error",
				statement: "Contest is not start"
			};
		}
		const contest_langmask = await getLangmaskForContest(positiveContestID);
		if (!checkLangmask(language, contest_langmask)) {
			return {
				status: "error",
				statement: "Your submission's language is invalid"
			};
		}
		const source_code = await makePrependAndAppendCode(problem_id, data.source, language);
		const source_code_user = deepCopy(data.source);
		const IP = getIP(req);
		const judger = "待分配";
		const fingerprint = data.fingerprint;
		const code_length = source_code_user.length;
		if (originalContestID !== positiveContestID) {
			problem_id = -Math.abs(problem_id);
		}
		const result = await query(`INSERT INTO solution(problem_id,user_id,in_date,language,ip,code_length,contest_id,num,judger,fingerprint)
	    values(?,?,NOW(),?,?,?,?,?,?,?)`, [problem_id, req.session.user_id, language, IP, code_length, positiveContestID, originalPID, judger, fingerprint]);
		const solution_id = result.insertId;
		let promiseArray = [query(`insert into source_code_user(solution_id,source)
		values(?,?)`, [solution_id, source_code_user]),
		query(`insert into source_code(solution_id, source)
		values(?,?)`, [solution_id, source_code])
		];

		if (originalContestID !== positiveContestID) {
			promiseArray.push(query(`insert into custominput(solution_id, input_text)
            values(?,?)`, [solution_id, data.input_text]));
		}
		await Promise.all(promiseArray);
		return {
			status: "OK",
			solution_id
		};
	} else if (submission_type === TOPIC_SUBMISSION) {
		const originalTopicID = parseInt(data.tid);
		const language = parseInt(data.language);
		const originalPID = parseInt(data.pid);
		if (isNaN(originalTopicID) || isNaN(originalPID)) {
			return {
				status: "error",
				statement: "Invalid topic_id or pid"
			};
		}
		const positiveTopicID = Math.abs(originalTopicID);
		let problem_id = await TopicIncludeProblem(positiveTopicID, originalPID);
		if (problem_id === false) {
			return {
				status: "error",
				statement: "problem is not in topic"
			};
		}
		if (!await checkTopicPrivilege(req, positiveTopicID)) {
			return {
				status: "error",
				statement: "You don't have privilege to access this topic"
			};
		}
		const topic_langmask = await getLangmaskForTopic(positiveTopicID);
		if (!checkLangmask(language, topic_langmask)) {
			return {
				status: "error",
				statement: "Your submission's language is invalid"
			};
		}

		const source_code = await makePrependAndAppendCode(problem_id, data.source, language);
		const source_code_user = deepCopy(data.source);
		const IP = getIP(req);
		const judger = "待分配";
		const fingerprint = data.fingerprint;
		const code_length = source_code_user.length;
		if (originalTopicID !== positiveTopicID) {
			problem_id = -Math.abs(problem_id);
		}
		const result = await query(`insert into solution(problem_id,user_id,in_date,language,ip,code_length,topic_id,num,judger,fingerprint)
		values(?,?,NOW(),?,?,?,?,?,?,?)`, [problem_id, req.session.user_id, language, IP, code_length, positiveTopicID, originalPID, judger, fingerprint]);

		const solution_id = result.insertId;
		let promiseArray = [query(`insert into source_code_user(solution_id,source)
		values(?,?)`, [solution_id, source_code_user]),
		query(`insert into source_code(solution_id, source)
		values(?,?)`, [solution_id, source_code])
		];
		if (originalTopicID !== positiveTopicID) {
			promiseArray.push(query(`insert into custominput(solution_id, input_text)
            values(?,?)`, [solution_id, data.input_text]));
		}
		await Promise.all(promiseArray);
		return {
			status: "OK",
			solution_id
		};
	}
};