# 招商银行银企直联国密免前置/SaaS对接示例，本示例仅供参考，不保证各种异常场景运行，请勿直接使用，如有错漏请联系对接人员。运行时，请使用所获取的测试资源替换 用户编号、公私钥、对称密钥、服务商编号等信息。

import base64
import binascii
import json
import requests
from urllib.parse import urlencode
from gmssl import sm2, sm3, sm4, func


class DcHelper:
    def __init__(self, url, uid, private_key, public_key, bank_public_key, sym_key):
        self.url = url
        self.uid = uid
        self.user_id = uid.ljust(16, '0').encode('ascii')
        self.alg = 'SM'
        # removeprefix("04") 是为了修复gmssl的设置公钥截断问题，.lstrip("04")函数导致的副作用
        self.sm2_crypt_user = sm2.CryptSM2(public_key=self.__base64_to_hex(public_key).removeprefix("04"),
                                           private_key=self.__base64_to_hex(private_key))
        self.sm2_crypt_bank = sm2.CryptSM2(public_key=self.__base64_to_hex(bank_public_key).removeprefix("04"),
                                           private_key='')
        self.sm4_encrypt = sm4.CryptSM4()
        self.sm4_encrypt.set_key(key=sym_key, mode=0)
        self.sm4_decrypt = sm4.CryptSM4()
        self.sm4_decrypt.set_key(key=sym_key, mode=1)

    def send_request(self, data, funcode):
        # 对请求报文做排序
        request_json = json.loads(data)
        request_json = self.__recursive_key_sort(request_json)
        source = json.dumps(request_json, separators=(',', ':'), ensure_ascii=False)
        # 生成签名
        signature = self.__cmb_sm2_sign_with_sm3(self.sm2_crypt_user, data=source.encode('utf-8'),
                                                 id=str(self.user_id.hex()))
        signature = self.__hex_to_base64(signature)
        # 替换签名字段
        request_json["signature"]["sigdat"] = signature

        # 对数据进行对称加密
        request = json.dumps(request_json, separators=(',', ':'), ensure_ascii=False)
        encrypt_request = self.sm4_encrypt.crypt_cbc(iv=self.user_id, input_data=request.encode('utf-8'))
        encrypt_request = base64.b64encode(encrypt_request)

        # 发送请求
        params = urlencode({"UID": self.uid, "ALG": self.alg, "DATA": encrypt_request, "FUNCODE": funcode})
        response = self.__http_post(self.url, params)
        if response.content.decode().startswith("CDCServer:"):
            raise Exception("访问目标地址 " + self.url + " 失败:" + response.content.decode())

        # 返回结果解密
        response = base64.b64decode(response.content)
        response = self.sm4_decrypt.crypt_cbc(iv=self.user_id, input_data=response)

        # 验证签名是否正确
        response_json = json.loads(response)
        res_signature = response_json["signature"]["sigdat"]
        response_json["signature"]["sigdat"] = "__signature_sigdat__"
        response_sorted = json.dumps(response_json, separators=(',', ':'), ensure_ascii=False)
        res = response_sorted.encode('utf-8')
        verify = self.__cmb_sm2_verify_with_sm3(self.sm2_crypt_bank, self.__base64_to_hex(res_signature), res,
                                                id=str(self.user_id.hex()))
        if verify != True:
            raise Exception("响应报文的签名无效");
        return response.decode()

    def __base64_to_hex(self, base64_string):
        decode_bytes = base64.b64decode(base64_string)
        hex_string = decode_bytes.hex()
        return hex_string.upper()

    def __hex_to_base64(self, hex_string):
        bytes_data = bytes.fromhex(hex_string)
        base64_string = base64.b64encode(bytes_data)
        return base64_string.decode()

    # 修改gmssl实现支持传入userid向量
    def __sm3_z(self, handler, data, id):
        """
        SM3WITHSM2 签名规则:  SM2.sign(SM3(Z+MSG)，PrivateKey)
        其中: z = Hash256(Len(ID) + ID + a + b + xG + yG + xA + yA)
        """
        # sm3withsm2 的 z 值
        z = '0080' + id + \
            handler.ecc_table['a'] + handler.ecc_table['b'] + handler.ecc_table['g'] + \
            handler.public_key
        z = binascii.a2b_hex(z)
        Za = sm3.sm3_hash(func.bytes_to_list(z))
        M_ = (Za + data.hex()).encode('utf-8')
        e = sm3.sm3_hash(func.bytes_to_list(binascii.a2b_hex(M_)))
        return e

    # 修改gmssl实现支持传入userid向量
    def __cmb_sm2_sign_with_sm3(self, handler, data, id, random_hex_str=None):
        sign_data = binascii.a2b_hex(self.__sm3_z(handler, data, id).encode('utf-8'))
        if random_hex_str is None:
            random_hex_str = func.random_hex(handler.para_len)
        sign = handler.sign(sign_data, random_hex_str)  # 16进制
        return sign

    # 修改gmssl实现支持传入userid向量
    def __cmb_sm2_verify_with_sm3(self, handler, sign, data, id):
        sign_data = binascii.a2b_hex(self.__sm3_z(handler, data, id).encode('utf-8'))
        return handler.verify(sign, sign_data)

    def __http_post(self, url, params=None):
        response = requests.post(url, params=params)

        if response.status_code != 200:
            raise Exception(f"Http 请求异常 with status code: {response.status_code} {response.content.decode()}")
        return response

    def __recursive_key_sort(self, data):
        if isinstance(data, dict):
            return {k: self.__recursive_key_sort(v) for k, v in sorted(data.items())}
        elif isinstance(data, list):
            return [self.__recursive_key_sort(item) for item in data]
        else:
            return data
