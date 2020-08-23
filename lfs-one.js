/*
lfs-one.js
Copyright (C) 2020 zhxxch
All rights reserved.
*/
"use strict"
const Https = require("https");
const FCClient = require('@alicloud/fc2');
const { TOKEN_API }
	= require("process").env;
function reply_cb(Callback, http_status, headers, body) {
	return Callback(null, {
		"isBase64Encoded": false,
		"statusCode": http_status,
		"headers": {
			"Cache-Control": "no-cache", "Content-Type":
				"application/vnd.git-lfs+json; charset=utf-8",
			...headers
		},
		"body": body
	});
}
function gen_err(status_code, msg, headers = []) {
	return {
		http_status: status_code, err_message: msg,
		headers: headers.reduce((obj, arr) => Object.assign(obj, { [arr[0]]: arr[1] }), {})
	};
}
function reply_error(Callback, Context, e) {
	console.error(e);
	reply_cb(Callback, e.http_status, e.headers, JSON.stringify({
		message: e.err_message,
		documentation_url:
			"https://github.com/git-lfs/git-lfs/blob/master/docs/api",
		request_id: Context.requestId
	}));
}
function gen_object_path(repo_name, oid) {
	const oid_12 = oid.slice(0, 2);
	const oid_34 = oid.slice(2, 4);
	return `${repo_name}/lfs/objects/${oid_12}/${oid_34}/${oid}`;
}
function validate_lfs_req(Req) {
	if (!(Req.headers["accept"] || "").startsWith(
		"application/vnd.git-lfs+json")) {
		throw gen_err(406, "（不支持当前客户端可接受的格式）Client accept media type invalid.", []);
	}
	if (!(Req.headers["content-type"] || "").startsWith(
		"application/vnd.git-lfs+json")) {
		throw gen_err(415, "（客户端请求格式不支持）Client posted invalid media type.", []);
	}
	return true;
}
async function op_download_onedrive(user_token,
	repo_name, objects_arr) {
	return Promise.all(objects_arr.map((reqobj) => {
		return new Promise((resolve, reject) => {
			if (!user_token) {
				reject(404);
			}
			const object_path
				= gen_object_path(repo_name, reqobj.oid);
			const req = Https.get(`https://graph.microsoft.com/v1.0/me/drive/special/approot:/${object_path}:/content`, {
				headers: {
					"Authorization": `Bearer ${user_token}`
				}
			}, resp => {
				if (resp.statusCode != 302) {
					reject(resp.statusCode);
				}
				resolve(resp.headers.location);
			});
		}).then(url => {
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
		}).catch(status_code => {
			if (status_code == 401) throw 401;
			return {
				oid: reqobj.oid,
				size: reqobj.size,
				error: {
					code: status_code,
					message: `OneDrive HTTP API error: ${status_code}`
				}
			};
		});
	}));
}
async function onedrive_batch_api(batch_req, repo_name, user_token) {
	if (batch_req.operation == "download") {
		return op_download_onedrive(
			user_token, repo_name, batch_req.objects
		).then(resp_obj_arr => ({
			transfer: "basic",
			objects: resp_obj_arr
		})).catch(e => {
			throw gen_err(500, "（OneDrive账户认证失败）Authentication with OneDrive failed.", []);
		});
	} else if (batch_req.operation == "upload") {
		throw gen_err(501, "（LFS服务器不支持上传操作）LFS endpoint: upload not implemented.", []);
	} else throw gen_err(501, "（LFS服务器不支持客户端请求的操作）LFS endpoint: operation not implemented.", []);
}
module.exports.handler = (EvBuffer, Context, Callback) => {
	setTimeout(() => {
		try {
			reply_cb(Callback, 408, {}, JSON.stringify({
				message: "（连接超时）Connention timeout.",
				documentation_url:
					"https://github.com/git-lfs/git-lfs/blob/master/docs/api",
				request_id: Context.requestId
			}))
		} catch{ }
	}, Context.function.timeout * 1000 - 500);
	const Event = JSON.parse(EvBuffer);
	const ReqBody = JSON.parse(Event.isBase64Encoded ? Buffer.from(Event.body, "base64") : Event.body);
	const [selected_api, user_id, RepoName, info_lfs, ApiPath] = Event.path.match(/^\/([^\/]+)\/(.+).git(\/info\/lfs)?\/(.+)$/) || [];
	try {
		if (!selected_api) {
			throw gen_err(404, "（LFS远程地址无效）Invalid LFS remote URL.", []);
		}
		if (ApiPath != "objects/batch") {
			throw gen_err(501, `（LFS服务器不支持“${ApiPath}”API）API ${ApiPath} not implemented.`, []);
		}
		validate_lfs_req(Event);
	} catch (e) {
		reply_error(Callback, Context, e);
		return;
	}
	const fc = new FCClient(Context.accountId, {
		accessKeyID: Context.credentials.accessKeyId,
		accessKeySecret:
			Context.credentials.accessKeySecret,
		securityToken: Context.credentials.securityToken,
		region: Context.region,
	});
	const PromisedToken = fc.get(
		`/proxy/${Context.service.name}/${TOKEN_API}/${user_id}`
	).then(r => r.data
	).catch(e => {
		if (e.code == 404) {
			return "";
		}
		throw new Error;
	});
	return PromisedToken.then(UserToken =>
		onedrive_batch_api(ReqBody, RepoName, UserToken)
	).then(BatchResp => {
		reply_cb(Callback, 200, {}, JSON.stringify(BatchResp));
	}).catch(e => {
		if (e instanceof Error) {
			console.error(e);
			throw gen_err(500, "（LFS服务器内部错误）LFS server internal error.", []);
		}
		throw e;
	}).catch(e => {
		reply_error(Callback, Context, e);
	});
}