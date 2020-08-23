/*
lfs-oss.js
Copyright (C) 2020 zhxxch
https://github.com/zhxxch/git-lfs-one

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/
"use strict"
const { OSSENDPOINT, OSSINTERNAL, BUCKET, TSENDPOINT, TSINSTANCE, TABLENAME, USERNAME, PASSWORD }
	= require("process").env;
const Crypto = require('crypto');
const OSS = require('ali-oss');
const Tablestore = require("tablestore");
function gen_err(status_code, msg, headers = []) {
	return {
		http_status: status_code, err_message: msg,
		setHeader: (resp) => {
			headers.map((header) => {
				resp.setHeader(header[0], header[1]);
			});
		}
	};
}
function reply_error(resp, context, e) {
	console.error(e);
	resp.setStatusCode(e.http_status);
	e.setHeader(resp);
	resp.send(JSON.stringify({
		message: e.err_message,
		documentation_url:
			"https://github.com/git-lfs/git-lfs/blob/master/docs/api",
		request_id: context.requestId
	}));
}
function gen_object_key(repo_name, oid) {
	const oid_12 = oid.slice(0, 2);
	const oid_34 = oid.slice(2, 4);
	return `${repo_name}/lfs.objects/${oid_12}/${oid_34}/${oid}`;
}
function gen_password_sha1(password_str) {
	return Crypto.createHash("sha1").update(password_str).end().digest();
}
function gen_htpasswd(username_str, password_str) {
	return username_str + ":{SHA}" + gen_password_sha1(password_str).toString("base64");
}
async function get_htpasswd(oss_client, htpasswd_key) {
	return oss_client.get(htpasswd_key).then(r => {
		return JSON.parse(r.content).map(htpasswd_str => {
			const [matched, username, passwd_sha1_str]
				= htpasswd_str
					.match(/([^:]+):\{SHA\}(\S+)/)
				|| [];
			if (!matched) {
				console.error(`${htpasswd_key} : obscure htpasswd ${htpasswd_str}.`);
				return {
					username: "",
					password_sha1: Buffer.alloc(20, 255)
				}
			}
			return {
				username: username, password_sha1: Buffer
					.from(passwd_sha1_str, "base64")
			};
		});
	}).catch(e => {
		if (e.status == 404) {
			oss_client.put(htpasswd_key,
				Buffer.from(JSON.stringify([
					gen_htpasswd(USERNAME, PASSWORD)])),
				{ mime: "application/json" }
			).then(() => {
				console.warn(`Created htpasswd file at ${htpasswd_key}.`);
			}).catch(e => {
				console.error(`Create htpasswd file at ${htpasswd_key} FAILED.`);
			});
		}
		console.error(e);
		return [{
			username: USERNAME,
			password_sha1: gen_password_sha1(PASSWORD)
		}];
	});
}
function validate_req_headers(Req) {
	if (!Req.headers["accept"].startsWith(
		"application/vnd.git-lfs+json")) {
		throw gen_err(406, "（客户端可接受的格式不支持）Client accept type invalid.", []);
	}
	if (Req.method == "POST"
		&& !Req.headers["content-type"].startsWith(
			"application/vnd.git-lfs+json")) {
		throw gen_err(415, "（客户端请求格式不支持）Content type invalid.", []);
	}
	return true;
}
function rfc3339time(d) {
	const padzero = (n) => n < 10 ? ("0" + n) : (n);
	const yyyy = d.getFullYear();
	const MM = padzero(d.getMonth() + 1);
	const dd = padzero(d.getDate());
	const hh = padzero(d.getHours());
	const mm = padzero(d.getMinutes());
	const ss = padzero(d.getSeconds());
	const timezone_offset = d.getTimezoneOffset();
	const offset_sign = (timezone_offset > 0 ? "-" : "+");
	const offset_hour = padzero(Math.floor(Math.abs(timezone_offset) / 60));
	const offset_minute = padzero(Math.floor(Math.abs(timezone_offset) - 60 * offset_hour));
	return `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}${offset_sign}${offset_hour}:${offset_minute}`
}
function lock_file_id(repo_name, path) {
	return Crypto.createHash("sha1").update(repo_name)
		.update("\n").update(path).digest();
}
function lock_id(file_id, owner_name, locked_at) {
	return Crypto.createHash("sha1").update(file_id)
		.update("\n").update(owner_name)
		.update("\n").update(locked_at).digest();
}
function map_ts_row(row) {
	return row.reduce((row, col) => Object.assign(row, { [col.columnName]: col.columnValue }), new Object);
}
async function lock_create(
	ts_client, repo_name, owner_name, lock_req) {
	const lock_at = rfc3339time(new Date);
	const file_id
		= lock_file_id(repo_name, lock_req.path);
	const id_buffer
		= lock_id(file_id, owner_name, lock_at);
	const lock_ferenda_attr = [
		{ repo_name: repo_name },
		{ path: lock_req.path },
		{ owner_name: owner_name },
		{ locked_at: lock_at },
		{ lock_id: id_buffer }];
	const create_lock_params = {
		tableName: TABLENAME,
		condition: new Tablestore.Condition(
			Tablestore.RowExistenceExpectation
				.EXPECT_NOT_EXIST, null),
		primaryKey: [{ file_id: file_id }],
		attributeColumns: lock_ferenda_attr
	};
	return ts_client.putRow(create_lock_params
	).then(() => {
		return {
			http_status: 201,
			body: JSON.stringify({
				lock: {
					id: id_buffer.toString("hex"),
					path: lock_req.path,
					locked_at: lock_at,
					owner: { name: owner_name }
				}
			})
		};
	}).catch(e => {
		const load_lock_params = {
			tableName: TABLENAME,
			primaryKey: [{ file_id: file_id }],
			columnsToGet: [
				"lock_id", "locked_at", "owner_name"]
		};
		return ts_client.getRow(load_lock_params
		).then(r => {
			const lock_lata
				= map_ts_row(r.row.attributes);
			return {
				http_status: 409, body: JSON.stringify({
					lock: {
						id: lock_lata.lock_id
							.toString("hex"),
						path: lock_req.path,
						locked_at: lock_lata.lock_at,
						owner: {
							name:
								lock_lata.owner_name
						}
					},
					message: "（无法重复锁定）Another lock exists."
				})
			};
		});
	}).catch(e => {
		console.error(e);
		throw gen_err(500, "Create lock FAILED.", []);
	});
}
async function lock_delete(
	ts_client, user_name, lock_id_str, req) {
	const lock_id_filter = new Tablestore
		.SingleColumnCondition(
			"lock_id", Buffer.from(lock_id_str, "hex"),
			Tablestore.ComparatorType.EQUAL, false);
	const query_file_id_params = {
		tableName: TABLENAME,
		direction: Tablestore.Direction.FORWARD,
		inclusiveStartPrimaryKey:
			[{ "file_id": Tablestore.INF_MIN }],
		exclusiveEndPrimaryKey:
			[{ "file_id": Tablestore.INF_MAX }],
		columnsToGet: [
			"lock_id", "locked_at", "owner_name", "path"],
		columnFilter: lock_id_filter, limit: 1
	};
	return ts_client.getRange(query_file_id_params
	).then(r => {
		if (r.rows.length < 1)
			throw gen_err(404, "Lock not found", []);
		const file_id = r.rows[0].primaryKey[0].value;
		const {
			matched_lock_id, locked_at, owner_name, path }
			= map_ts_row(r.rows[0].attributes);
		if (!(owner_name == user_name || req.force))
			throw gen_err(403, "（不能解锁其他用户添加的锁）Unlock failed: not owner of lock.", []);
		return {
			file_id: file_id, lock: {
				lock: {
					id: lock_id_str,
					path: path, locked_at: locked_at,
					owner: { name: owner_name }
				}
			}
		};
	}).then(({ file_id, lock }) => {
		const delete_lock_params = {
			tableName: TABLENAME,
			condition: new Tablestore.Condition(Tablestore
				.RowExistenceExpectation.IGNORE, null),
			primaryKey: [{ file_id: file_id }],
		};
		return ts_client.deleteRow(delete_lock_params
		).then(() => {
			return {
				http_status: 200,
				body: JSON.stringify(lock)
			};
		}).catch(() => {
			throw gen_err(500, "Delete lock FAILED.", []);
		})
	}).catch(e => {
		if (e instanceof Error) {
			console.error(e);
			throw gen_err(500, "Delete lock FAILED.", []);
		}
		throw e;
	});
}
async function lock_list(ts_client, repo_name, queries) {
	const repo_name_filter = new Tablestore
		.SingleColumnCondition(
			"repo_name", repo_name,
			Tablestore.ComparatorType.EQUAL, false);
	const list_lock_filter = new Tablestore
		.CompositeCondition(
			Tablestore.LogicalOperator.AND);
	list_lock_filter.addSubCondition(repo_name_filter);
	if (queries.path) {
		const path_filter = new Tablestore
			.SingleColumnCondition(
				"path", queries.path,
				Tablestore.ComparatorType.EQUAL, false);
		list_lock_filter.addSubCondition(path_filter);
	}
	if (queries.id) {
		const lock_id_filter = new Tablestore
			.SingleColumnCondition(
				"lock_id", Buffer.from(queries.id, "hex"),
				Tablestore.ComparatorType.EQUAL, false);
		list_lock_filter.addSubCondition(lock_id_filter);
	}
	const start_file_id = queries.cursor
		? Buffer.from(queries.cursor, "hex")
		: Tablestore.INF_MIN;
	const list_locks_params = {
		tableName: TABLENAME,
		direction: Tablestore.Direction.FORWARD,
		inclusiveStartPrimaryKey:
			[{ "file_id": start_file_id }],
		exclusiveEndPrimaryKey:
			[{ "file_id": Tablestore.INF_MAX }],
		columnsToGet: [
			"lock_id", "locked_at", "owner_name",
			"path", "repo_name"],
		columnFilter: ((queries.id || queries.path)
			? list_lock_filter : repo_name_filter),
		limit: queries.limit
	};
	return ts_client.getRange(list_locks_params
	).then(r => {
		if (r.rows.length == 0) return { locks: [] };
		const locks = r.rows.map(row => {
			const res_lock = map_ts_row(row.attributes);
			return {
				id: res_lock.lock_id.toString("hex"),
				path: res_lock.path,
				locked_at: res_lock.locked_at,
				owner: { name: res_lock.owner_name }
			};
		});
		if (r.nextStartPrimaryKey)
			return {
				locks: locks,
				next_cursor: next_cursor.toString("hex")
			};
		else return { locks: locks };
	}).then(r => {
		return {
			http_status: 200, body: JSON.stringify(r)
		};
	}).catch(e => {
		console.error(e);
		throw gen_err(500, "List locks FAILED.", []);
	});
}
async function lock_verify(
	ts_client, repo_name, user_name, verify_req) {
	const repo_name_filter = new Tablestore
		.SingleColumnCondition("repo_name", repo_name,
			Tablestore.ComparatorType.EQUAL, false);
	const start_file_id = verify_req.cursor
		? Buffer.from(verify_req.cursor, "hex")
		: Tablestore.INF_MIN;
	const verify_locks_params = {
		tableName: TABLENAME,
		direction: Tablestore.Direction.FORWARD,
		inclusiveStartPrimaryKey:
			[{ "file_id": start_file_id }],
		exclusiveEndPrimaryKey:
			[{ "file_id": Tablestore.INF_MAX }],
		columnsToGet: [
			"lock_id", "locked_at", "owner_name",
			"path", "repo_name"],
		columnFilter: repo_name_filter, limit: verify_req.limit
	};
	return ts_client.getRange(verify_locks_params).then(r => {
		if (r.rows.length == 0) return { ours: [], theirs: [] };
		const locks = r.rows.map(row => {
			const res_lock = map_ts_row(row.attributes);
			return {
				id: res_lock.lock_id.toString("hex"),
				path: res_lock.path,
				locked_at: res_lock.locked_at,
				owner: { name: res_lock.owner_name }
			};
		});
		const ours = locks.filter(lock =>
			lock.owner.name == user_name);
		const theirs = locks.filter(lock =>
			lock.owner.name != user_name);
		if (r.nextStartPrimaryKey)
			return {
				ours: ours, theirs: theirs,
				next_cursor: r.nextStartPrimaryKey.value
					.toString("hex")
			};
		else return { ours: ours, theirs: theirs };
	}).then(r => {
		return { http_status: 200, body: JSON.stringify(r) };
	}).catch(e => {
		console.error(e);
		throw gen_err(500, "List locks FAILED.", []);
	});
}
async function op_download_oss(
	oss_client, repo_name, objects_arr) {
	return Promise.all(objects_arr.map(reqobj => {
		return oss_client.getObjectMeta(
			gen_object_key(repo_name, reqobj.oid)
		).then(() => {
			const url = oss_client.signatureUrl(
				gen_object_key(repo_name, reqobj.oid), {
				expires: 3600, method: "GET"
			});
			return {
				oid: reqobj.oid,
				size: reqobj.size,
				authenticated: true,
				actions: {
					download: {
						href: url,
						expires_in: 3600
					}
				}
			}
		}).catch(e => {
			return {
				oid: reqobj.oid,
				size: reqobj.size,
				error: {
					code: e.status,
					message: e.code
				}
			};
		});
	}));
}
async function op_upload_oss(
	oss_client, repo_name, objects_arr) {
	return Promise.all(objects_arr.map(reqobj => {
		return oss_client.getObjectMeta(
			gen_object_key(repo_name, reqobj.oid)
		).then(() => {
			return {
				oid: reqobj.oid,
				size: reqobj.size,
			};
		}).catch(() => {
			const url = oss_client.signatureUrl(
				gen_object_key(repo_name, reqobj.oid), {
				expires: 3600,
				method: "PUT", "Content-Type":
					"application/octet-stream"
			});
			return {
				oid: reqobj.oid,
				size: reqobj.size,
				authenticated: true, actions: {
					upload: {
						href: url, header: {
							"Content-Type":
								"application/octet-stream"
						}, expires_in: 3600
					}
				}
			};
		});
	}));
}

async function oss_batch(
	oss_client, repo_name, batch_req) {
	console.info(`Batch API: ${batch_req.operation}`);
	const operation_selector = (req_operation) => {
		if (req_operation == "download") {
			return op_download_oss;
		} else if (req_operation == "upload") {
			return op_upload_oss;
		} else throw gen_err(501, "（操作不支持）Operation not implemented.", []);
	};
	return operation_selector(batch_req.operation)(
		oss_client, repo_name, batch_req.objects
	).then(resp_obj_arr => {
		return {
			http_status: 200, body: JSON.stringify({
				transfer: "basic",
				objects: resp_obj_arr
			})
		};
	});
}
function gen_oss_client(Context, endpoint, bucket) {
	return new OSS({
		accessKeyId: Context.credentials.accessKeyId,
		accessKeySecret:
			Context.credentials.accessKeySecret,
		stsToken: Context.credentials.securityToken,
		timeout: Context.function.timeout * 500,
		endpoint: endpoint,
		bucket: bucket
	});
}
function gen_ts_client(Context, endpoint, instance) {
	return new Tablestore.Client({
		...Context.credentials,
		endpoint: endpoint,
		instancename: instance
	});
}
function path_router(Request, oss_client, ts_client, RepoName, ApiPath, Username) {
	if (Request.method == "POST"
		&& ApiPath == "objects/batch") {
		return (request_body) => oss_batch(oss_client, RepoName, request_body);
	}
	if (Request.method == "GET"
		&& ApiPath == "locks") {
		return (request_body) => lock_list(ts_client, RepoName, Request.queries);
	} else if (Request.method != "POST") {
		throw gen_err(405, `（客户端请求方法错误）Wrong METHOD: ${Request.method}`, [["Allow", "GET, POST"]]);
	}
	if (ApiPath == "locks") {
		return (request_body) => lock_create(ts_client, RepoName, Username, request_body);
	}
	if (ApiPath == "locks/verify") {
		return (request_body) => lock_verify(ts_client, RepoName, Username, request_body);
	}
	const [matched_delete_lock_req, lock_id_str]
		= ApiPath.match(/^locks\/(.+)\/unlock$/) || [];
	if (lock_id_str) {
		return (request_body) => lock_delete(ts_client, Username, lock_id_str, request_body);
	}
	throw gen_err(400, `${Request.path}（无效请求）Bad request.`, []);
}
function install_timeout_exit(resp, context) {
	return setTimeout(() => {
		try {
			resp.setStatusCode(408);
			resp.send(JSON.stringify({
				message: "（连接超时）Connention timeout.",
				documentation_url:
					"https://github.com/git-lfs/git-lfs/blob/master/docs/api",
				request_id: context.requestId
			}));
		} catch{ }
	}, context.function.timeout * 1000 - 500);
}
async function http_body_json(req) {
	return new Promise((resolve, reject) => {
		if (req.method == "GET") resolve();
		const body_parts = [];
		req.on("data", chunk =>
			body_parts.push(Buffer.from(chunk)));
		req.on("error", e => reject(e));
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(body_parts)))
			} catch (e) {
				reject(e);
			}
		});
		req.on("close", () => { });
		req.on("aborted", () => { });
	});
}
function log_visit(req) {
	console.info(JSON.stringify((({ clientIP, url }) => ({ clientIP, url }))(req)));
}
function set_http_header(resp) {
	resp.setHeader("Cache-Control", "no-cache");
	resp.setHeader("Content-Type",
		"application/vnd.git-lfs+json; charset=utf-8");
}
function decode_auth_header(header_value) {
	try {
		return Buffer.from(header_value.substring(
			header_value.indexOf(" ") + 1),
			"base64").toString("utf-8");
	} catch{
		return "";
	}
}
const LFSPathRegex = /^\/?([^\/]?.*)\/([^\/]+.git)(\/info\/lfs)?\/(.*[^\/])\/?$/;
module.exports.handler = (Req, Resp, Context) => {
	install_timeout_exit(Resp, Context);
	log_visit(Req);
	set_http_header(Resp);
	const PromisedJsonBody = http_body_json(Req);
	const oss_client = gen_oss_client(Context,
		OSSENDPOINT, BUCKET);
	const oss_internal = gen_oss_client(Context,
		OSSINTERNAL || OSSENDPOINT, BUCKET);
	const ts_client = gen_ts_client(Context,
		TSENDPOINT, TSINSTANCE);
	try {
		validate_req_headers(Req);
	} catch (e) {
		reply_error(Resp, Context, e)
		return;
	}
	const [MatchedPath, UrlPrefixs,
		RepoName, info_lfs, ApiPath]
		= Req.path.match(LFSPathRegex) || [];
	if (!MatchedPath) {
		reply_error(Resp, Context, gen_err(400, "（客户端请求无效）Bad request.", []));
		return;
	}
	const [MatchedCredentials, Username, PasswordPt]
		= (decode_auth_header(Req.headers.authorization)
			.match(/^([^:]+):(.+)$/) || ["", "", ""]);
	const PasswordSHA1
		= gen_password_sha1(PasswordPt);
	const validate_password = legit_credential => {
		return Username == legit_credential.username
			&& !PasswordSHA1.compare(
				legit_credential.password_sha1);
	}
	const htpasswd_key
		= `${RepoName}/lfs.htpasswd.json`;
	const PromisedCredentials
		= get_htpasswd(oss_internal, htpasswd_key);
	return Promise.all([
		PromisedJsonBody, PromisedCredentials
	]).then(([RequestBody, LegitCredentials]) => {
		const matched_password = LegitCredentials
			.filter(validate_password);
		if (matched_password.length == 0) {
			if (ApiPath == "objects/batch"
				&& RequestBody.operation == "download") {
			} else if (!Req.headers.authorization) {
				throw gen_err(401,
					"（未认证的访问）Client performed no authentication.",
					[["LFS-Authenticate:",
						"Basic realm=\"Git LFS\""]]);
			} else throw gen_err(403, "（用户名或密码错误）Incorrect username or password.", []);
		}
		const ServeSelectedApi = path_router(
			Req, oss_client, ts_client,
			RepoName, ApiPath, Username);
		return ServeSelectedApi(RequestBody);
	}).then(({ http_status, body }) => {
		Resp.setStatusCode(http_status);
		Resp.send(body);
	}).catch(e => {
		if (e instanceof Error) {
			console.error(e);
			throw gen_err(500, "（服务器内部错误）Server internal error.", []);
		}
		throw e;
	}).catch(e => reply_error(Resp, Context, e));
}